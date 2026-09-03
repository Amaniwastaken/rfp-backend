import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type } from '@google/genai';
import { PDFParse } from 'pdf-parse';
import Stripe from 'stripe';
import rateLimit from 'express-rate-limit';

const app = express();
app.use(cors());

// ==========================================
// 1. STRIPE WEBHOOK (Must be raw buffer)
// ==========================================
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;
    const customerId = session.customer;
    
    // Auto-map based on checkout amount (Update to match your Stripe prices)
    let newTier = 'Starter';
    if (session.amount_total === 4900) newTier = 'Growth';
    if (session.amount_total === 9900) newTier = 'Agency';

    if (userId) {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      await supabase.from('profiles').update({ tier: newTier, stripe_customer_id: customerId }).eq('id', userId);
    }
  }
  res.json({ received: true });
});

// Use JSON for all other routes
app.use(express.json());

// ==========================================
// 2. RATE LIMITING & INIT
// ==========================================
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 40,
  message: { error: "Too many requests. Please try again in 15 minutes." }
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ==========================================
// 3. AUTOFILL ROUTE (With Refund & Limits)
// ==========================================
app.post('/api/autofill', apiLimiter, async (req, res) => {
  const { fields, token } = req.body;
  if (!token) return res.status(401).json({ error: "Unauthorized." });

  try {
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: "Invalid session." });

    const { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    if (!profile) return res.status(404).json({ error: "Account not found." });

    const tierLimits = { Free: 3, Starter: 15, Growth: 30, Agency: -1 };
    const userLimit = tierLimits[profile.tier] !== undefined ? tierLimits[profile.tier] : 3;

    // 1. Atomic Check & Increment
    const { data: hasQuota } = await supabase.rpc('process_form_usage', { target_user_id: user.id, max_limit: userLimit });
    if (!hasQuota) return res.status(403).json({ error: `PAYWALL: You have reached your ${profile.tier} tier limit.` });
    
    const allowToneRules = (profile.tier === 'Growth' || profile.tier === 'Agency');
    const includeWatermark = (profile.tier === 'Free' || profile.tier === 'Starter');

    // 2. Fetch PDFs (Capped at 3 to save memory/costs)
    const { data: fileList } = await supabase.storage.from('knowledge_base').list(`${user.id}/`);
    if (!fileList || fileList.length === 0) {
      await supabase.rpc('refund_form_usage', { target_user_id: user.id });
      return res.status(404).json({ error: "No company docs found." });
    }

    let companyKnowledgeBase = "";
    let parsedCount = 0;

    for (const file of fileList) {
      if (parsedCount >= 3) break;
      if (!file.name.endsWith('.pdf')) continue;

      const { data: pdfBlob } = await supabase.storage.from('knowledge_base').download(`${user.id}/${file.name}`);
      if (pdfBlob) {
        try {
          const buffer = Buffer.from(await pdfBlob.arrayBuffer());
          const parsedPdf = await PDFParse({ data: buffer });
          companyKnowledgeBase += `\n--- Document: ${file.name} ---\n${parsedPdf.text}\n`;
          parsedCount++;
        } catch (e) { console.error("PDF Parse error", e); }
      }
    }

    if (!companyKnowledgeBase.trim()) {
      await supabase.rpc('refund_form_usage', { target_user_id: user.id });
      return res.status(404).json({ error: "No readable text found in PDFs." });
    }

    // 3. Fetch Memory Bank
    const { data: savedMemory } = await supabase.from('custom_answers').select('question, answer').eq('user_id', user.id);
    let memoryContext = "PREVIOUSLY SAVED MANUAL ANSWERS:\n";
    if (savedMemory) savedMemory.forEach(item => { memoryContext += `Question: ${item.question}\nAnswer: ${item.answer}\n\n`; });

    const responseSchema = {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { field_index: { type: Type.INTEGER }, answer: { type: Type.STRING } },
        required: ["field_index", "answer"]
      }
    };

    let prompt = `
      You are an expert sales engineer filling out a B2B security questionnaire.
      REFERENCE KNOWLEDGE BASE:
      ${companyKnowledgeBase}
      ${memoryContext}
      FORM QUESTIONS:
      ${JSON.stringify(fields)}
      INSTRUCTIONS: 
      1. Check "PREVIOUSLY SAVED MANUAL ANSWERS" first.
      2. If not, find the answer in the "REFERENCE KNOWLEDGE BASE".
      3. If neither contains the answer, output exactly: "[NEEDS_INPUT]"
    `;

    if (allowToneRules && profile.tone_rules) {
      prompt += `\n\nAPPLY THESE CUSTOM TONE RULES TO ALL ANSWERS:\n${profile.tone_rules.trim()}`;
    }

    const aiResponse = await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: prompt,
      config: { responseMimeType: 'application/json', responseSchema, temperature: 0.1 }
    });

    const structuredAnswers = JSON.parse(aiResponse.text);

    // 4. Refund if AI failed completely or had NO answers
    const hasRealAnswers = structuredAnswers.some(ans => ans.answer !== "[NEEDS_INPUT]");
    if (!structuredAnswers || structuredAnswers.length === 0 || !hasRealAnswers) {
      await supabase.rpc('refund_form_usage', { target_user_id: user.id });
    }

    return res.json({ status: "SUCCESS", answers: structuredAnswers, includeWatermark });

  } catch (err) {
    if (req.body.token) {
       const { data: { user } } = await supabase.auth.getUser(req.body.token);
       if (user) await supabase.rpc('refund_form_usage', { target_user_id: user.id });
    }
    console.error(err);
    return res.status(500).json({ error: "Failed to generate AI answers." });
  }
});

// Learn and Support Routes
app.post('/api/learn', apiLimiter, async (req, res) => {
  const { qnaPairs, token } = req.body;
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const upsertData = qnaPairs.map(p => ({ user_id: user.id, question: p.question, answer: p.answer }));
  await supabase.from('custom_answers').upsert(upsertData, { onConflict: 'user_id, question' });
  return res.json({ status: "SUCCESS" });
});

app.post('/api/support', apiLimiter, async (req, res) => {
  const { message, email, token } = req.body;
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  await supabase.from('support_inquiries').insert([{ user_id: user.id, email, message }]);
  return res.json({ status: "SUCCESS" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
