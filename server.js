import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type } from '@google/genai';
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
    const { data: profile, error: profileError } = await supabase.from('profiles').select('*').eq('id', user.id).single();

    if (profileError || !profile) {
      console.error("Profile lookup failed:", profileError);
      return res.status(404).json({ error: "No account profile found. Please contact support." });
    }

    if (profile.tier === 'Free' && profile.forms_filled >= 3) {
      return res.status(403).json({ error: "PAYWALL: Free trial limit reached (3 forms). Please upgrade to Starter!" });
    }
    if (profile.tier === 'Starter' && profile.forms_filled >= 15) {
      return res.status(403).json({ error: "PAYWALL: Starter monthly limit reached (15 forms). Upgrade to Growth!" });
    }
    if (profile.tier === 'Growth' && profile.forms_filled >= 30) {
      return res.status(403).json({ error: "PAYWALL: Growth monthly limit reached (30 forms). Upgrade to Agency for unlimited forms!" });
    }
    // Agency tier has no limit check, so it flows right through!

    // ==========================================
    // 3. FETCH ALL USER PDFS (Multi-file Support)
    // ==========================================
    const { data: fileList, error: listError } = await supabase.storage
      .from('knowledge_base')
      .list(`${user.id}/`);
      
    if (listError || !fileList || fileList.length === 0) {
      return res.status(404).json({ error: "Knowledge base missing. Please upload your company docs in the dashboard." });
    }

    let companyKnowledgeBase = "";

    for (const file of fileList) {
      if (file.name === '.emptyFolderPlaceholder' || !file.name.endsWith('.pdf')) continue;

      const { data: pdfBlob, error: downloadError } = await supabase.storage
        .from('knowledge_base')
        .download(`${user.id}/${file.name}`);
        
      if (!downloadError && pdfBlob) {
        try {
          const arrayBuffer = await pdfBlob.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);

          const parser = new PDFParse({ data: buffer });
          const parsedPdf = await parser.getText();

          companyKnowledgeBase += `\n--- Document: ${file.name} ---\n${parsedPdf.text}\n`;
        } catch (parseErr) {
          // Don't let one corrupt/unreadable PDF kill the whole request —
          // skip it and keep going with whatever else is in the knowledge base.
          console.error(`Failed to parse ${file.name}:`, parseErr);
        }
      }
    }

    if (!companyKnowledgeBase.trim()) {
      return res.status(404).json({ error: "No readable text found in uploaded PDFs." });
    }

    // ==========================================
    // 4. FETCH MEMORY BANK (Custom Typed Answers)
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

    // 5. Force Gemini to output Strict JSON Array matching our schema
    const responseSchema = {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          field_index: { type: Type.INTEGER, description: "The exact field_index provided in the prompt" },
          answer: { type: Type.STRING, description: "The extracted answer for this form field" }
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
      3. If the answer does not exist in EITHER, you MUST output exactly: "[NEEDS_INPUT]"
    `;

    // 6. Query Gemini 2.5 Flash
    const aiResponse = await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: responseSchema,
        temperature: 0.1 
      }
    });

    const structuredAnswers = JSON.parse(aiResponse.text);

    // 7. Increment forms_filled count
    await supabase.from('profiles').update({ forms_filled: profile.forms_filled + 1 }).eq('id', user.id);

    // 8. Send answers back to the Chrome Extension
    return res.json({ status: "SUCCESS", answers: structuredAnswers });

  } catch (err) {
    console.error("Backend Error:", err);
    return res.status(500).json({ error: "Failed to generate AI answers. Try again." });
  }
});

// ==========================================
// 9. LEARN ROUTE (Saves manual answers to DB)
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
// ==========================================
// 10. SUPPORT / FEEDBACK ROUTE (SUPABASE)
// ==========================================
app.post('/api/support', async (req, res) => {
  const { message, email, token } = req.body;
  
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  if (!message) return res.status(400).json({ error: "No message provided" });

  try {
    // Authenticate the user securely
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: "Invalid session" });

    // Insert the ticket into Supabase
    const { error } = await supabase
      .from('support_inquiries')
      .insert([{ user_id: user.id, email: email, message: message }]);

    if (error) throw error;
    
    return res.json({ status: "SUCCESS" });
  } catch (err) {
    console.error("Support Error:", err);
    return res.status(500).json({ error: "Failed to save message." });
  }
});
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
