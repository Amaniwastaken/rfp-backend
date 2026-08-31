import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type } from '@google/genai';

// pdf-parse v2+ uses a class-based API (no more bare function export)
import { PDFParse } from 'pdf-parse';

const app = express();
app.use(cors());
app.use(express.json());

// Initialize external clients
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.post('/api/autofill', async (req, res) => {
  const { fields, token } = req.body;

  if (!token) return res.status(401).json({ error: "Unauthorized: Please log into the extension." });

  try {
    // 1. Authenticate the user via Supabase
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: "Invalid session. Please log in again." });

    // 2. Paywall & Usage Enforcement
    const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    if (profile.tier === 'Free' && profile.forms_filled >= 3) {
      return res.status(403).json({ error: "PAYWALL: Free trial limit reached. Upgrade to Pro!" });
    }
    if (profile.tier === 'Starter' && profile.forms_filled >= 15) {
      return res.status(403).json({ error: "PAYWALL: Monthly limit reached. Upgrade to Growth!" });
    }

    // 3. Fetch User's PDF from Supabase Storage & Parse it
   // 3. Fetch ALL User PDFs from Supabase Storage & Parse them
    const { data: fileList, error: listError } = await supabase.storage
      .from('knowledge_base')
      .list(`${user.id}/`);
      
    if (listError || !fileList || fileList.length === 0) {
      return res.status(404).json({ error: "No documents found. Please upload company docs in the extension." });
    }

    let companyKnowledgeBase = "";

    // Loop through every file the user uploaded
    for (const file of fileList) {
      if (file.name === '.emptyFolderPlaceholder' || !file.name.endsWith('.pdf')) continue;

      const { data: pdfBlob, error: downloadError } = await supabase.storage
        .from('knowledge_base')
        .download(`${user.id}/${file.name}`);
        
      if (!downloadError && pdfBlob) {
        const arrayBuffer = await pdfBlob.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        const extractPdfText = typeof pdfParse === 'function' ? pdfParse : pdfParse.default;
        const parsedPdf = await extractPdfText(buffer);
        
        companyKnowledgeBase += `\n--- Document: ${file.name} ---\n${parsedPdf.text}\n`;
      }
    }
    // Convert Blob to Buffer and extract text
    const arrayBuffer = await pdfBlob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const parser = new PDFParse({ data: buffer });
    const parsedPdf = await parser.getText();
    const companyKnowledgeBase = parsedPdf.text;

    // 4. Force Gemini to output Strict JSON Array matching our schema
// (Inside your /api/autofill route, right before the Gemini Prompt)
    
    // Fetch the user's custom saved answers
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

    const prompt = `
      You are an expert sales engineer filling out a B2B security questionnaire.
      REFERENCE KNOWLEDGE BASE (PDFs):
      ${companyKnowledgeBase}

      ${memoryContext}

      FORM QUESTIONS:
      ${JSON.stringify(fields)}

      INSTRUCTIONS: 
      1. First, check the "PREVIOUSLY SAVED MANUAL ANSWERS". If the answer is there, use it exactly.
      2. If not, find the answer in the "REFERENCE KNOWLEDGE BASE".
      3. If the answer does not exist in EITHER, you MUST output exactly this string: "[NEEDS_INPUT]"
    `;

    // 5. Query Gemini (fastest model for DOM injection)
    const aiResponse = await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: responseSchema,
        temperature: 0.1 // Keep it factual, no creative guessing
      }
    });

    const structuredAnswers = JSON.parse(aiResponse.text);

    // 6. Increment forms_filled count
    await supabase.from('profiles').update({ forms_filled: profile.forms_filled + 1 }).eq('id', user.id);

    // 7. Send answers back to the Chrome Extension
    return res.json({ status: "SUCCESS", answers: structuredAnswers });

  } catch (err) {
    console.error("Backend Error:", err);
    return res.status(500).json({ error: "Failed to generate AI answers. Try again." });
  }
});

const PORT = process.env.PORT || 3000;
// NEW ROUTE: Save manual answers to the database
app.post('/api/learn', async (req, res) => {
  const { qnaPairs, token } = req.body;
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: "Invalid session" });

    // Format data for Supabase upsert (updates existing questions, inserts new ones)
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
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
