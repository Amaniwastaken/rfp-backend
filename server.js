import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type } from '@google/genai';
import { createRequire } from 'module';

// Safely import the older pdf-parse package
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize clients
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.post('/api/autofill', async (req, res) => {
  const { fields, token } = req.body;

  if (!token) return res.status(401).json({ error: "Unauthorized: Please log into the extension." });

  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: "Invalid session. Please log in again." });

    const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    if (profile.tier === 'Free' && profile.forms_filled >= 3) {
      return res.status(403).json({ error: "PAYWALL: Free trial limit reached. Upgrade to Pro!" });
    }

    // ==========================================
    // 1. FETCH ALL PDFS (Multi-file Support)
    // ==========================================
    const { data: fileList, error: listError } = await supabase.storage.from('knowledge_base').list(`${user.id}/`);
      
    if (listError || !fileList || fileList.length === 0) {
      return res.status(404).json({ error: "Knowledge base missing. Please upload company docs." });
    }

    let companyKnowledgeBase = "";

    for (const file of fileList) {
      if (file.name === '.emptyFolderPlaceholder' || !file.name.endsWith('.pdf')) continue;

      const { data: pdfBlob, error: downloadError } = await supabase.storage
        .from('knowledge_base')
        .download(`${user.id}/${file.name}`);
        
      if (!downloadError && pdfBlob) {
        const arrayBuffer = await pdfBlob.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        // Bulletproof pdf parser execution
        let parsedPdf;
        if (typeof pdfParse === 'function') {
          parsedPdf = await pdfParse(buffer);
        } else if (pdfParse.default && typeof pdfParse.default === 'function') {
          parsedPdf = await pdfParse.default(buffer);
        } else {
          const parseFn = pdfParse.default || pdfParse;
          parsedPdf = await parseFn(buffer);
        }
        
        companyKnowledgeBase += `\n--- Document: ${file.name} ---\n${parsedPdf.text}\n`;
      }
    }

    if (!companyKnowledgeBase.trim()) {
      return res.status(404).json({ error: "No readable text found in PDFs." });
    }

    // ==========================================
    // 2. FETCH MEMORY BANK (Custom Typed Answers)
    // ==========================================
    const { data: savedMemory } = await supabase
      .from('custom_answers')
      .select('question, answer')
      .eq('user_id', user.id);
      
    let memoryContext = "PREVIOUSLY SAVED MANUAL ANSWERS:\n";
    if (savedMemory && savedMemory.length > 0) {
      savedMemory.forEach(item => {
        memoryContext += `Question: ${item.question}\nAnswer: ${item.answer}\n\n`;
      });
    }

    // ==========================================
    // 3. AI GENERATION
    // ==========================================
    const responseSchema = {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          field_index: { type: Type.INTEGER },
          answer: { type: Type.STRING }
        },
        required: ["field_index", "answer"]
      }
    };

    const prompt = `
      You are an expert sales engineer filling out a B2B security questionnaire.
      REFERENCE KNOWLEDGE BASE:
      ${companyKnowledgeBase}

      ${memoryContext}

      FORM QUESTIONS:
      ${JSON.stringify(fields)}

      INSTRUCTIONS: 
      1. Check "PREVIOUSLY SAVED MANUAL ANSWERS". If the answer is there, use it exactly.
      2. If not, find the answer in the "REFERENCE KNOWLEDGE BASE".
      3. If the answer does not exist in EITHER, output exactly: "[NEEDS_INPUT]"
    `;

    const aiResponse = await ai.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: responseSchema,
        temperature: 0.1 
      }
    });

    const structuredAnswers = JSON.parse(aiResponse.text);

    await supabase.from('profiles').update({ forms_filled: profile.forms_filled + 1 }).eq('id', user.id);

    return res.json({ status: "SUCCESS", answers: structuredAnswers });

  } catch (err) {
    console.error("Backend Error:", err);
    return res.status(500).json({ error: "Failed to generate AI answers." });
  }
});

// ==========================================
// 4. LEARN ROUTE (Saves typed answers to DB)
// ==========================================
app.post('/api/learn', async (req, res) => {
  const { qnaPairs, token } = req.body;
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: "Invalid session" });

    const upsertData = qnaPairs.map(pair => ({
      user_id: user.id,
      question: pair.question,
      answer: pair.answer
    }));

    const { error } = await supabase
      .from('custom_answers')
      .upsert(upsertData, { onConflict: 'user_id, question' });

    if (error) throw error;
    return res.json({ status: "SUCCESS" });

  } catch (err) {
    console.error("Learn Error:", err);
    return res.status(500).json({ error: "Failed to save memory." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
