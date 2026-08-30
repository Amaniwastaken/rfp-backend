import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type } from '@google/genai';

// Safely import the older pdf-parse package
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
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
    // Assumption: The user's dashboard uploads their doc to the 'knowledge_base' bucket as `{user.id}/docs.pdf`
    const { data: pdfBlob, error: downloadError } = await supabase.storage
      .from('knowledge_base')
      .download(`${user.id}/docs.pdf`);
      
    if (downloadError) {
      return res.status(404).json({ error: "Knowledge base missing. Please upload your company docs in the dashboard." });
    }

    // Convert Blob to Buffer and extract text
    const arrayBuffer = await pdfBlob.arrayBuffer();
    const parsedPdf = await pdfParse(Buffer.from(arrayBuffer));
    const companyKnowledgeBase = parsedPdf.text;

    // 4. Force Gemini to output Strict JSON Array matching our schema
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

      FORM QUESTIONS:
      ${JSON.stringify(fields)}

      INSTRUCTIONS: 
      Read each form question. Find the answer in the reference knowledge base. Provide a concise, professional answer for each field. 
      If the answer is not in the knowledge base, output "Information not available in provided documentation."
    `;

    // 5. Query Gemini 1.5 Flash (Fastest model for DOM injection)
    const aiResponse = await ai.models.generateContent({
      model: 'gemini-1.5-flash',
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
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
