import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI, Type } from '@google/genai';
import { PDFParse } from 'pdf-parse';
import Stripe from 'stripe';

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

// Initialize Clients
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ==========================================
// 2. AUTOFILL ROUTE (With Refund & Limits)
// ==========================================
app.post('/api/autofill', async (req, res) => {
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
app.post('/api/learn', async (req, res) => {
  const { qnaPairs, token } = req.body;
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const upsertData = qnaPairs.map(p => ({ user_id: user.id, question: p.question, answer: p.answer }));
  await supabase.from('custom_answers').upsert(upsertData, { onConflict: 'user_id, question' });
  return res.json({ status: "SUCCESS" });
});

app.post('/api/support', async (req, res) => {
  const { message, email, token } = req.body;
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  await supabase.from('support_inquiries').insert([{ user_id: user.id, email, message }]);
  return res.json({ status: "SUCCESS" });
});

const PORT = process.env.PORT || 3000;
// ==========================================
// 4. HOSTED PASSWORD RESET PAGE
// ==========================================
app.get('/reset-password', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Reset Password - RFP Auto-Filler</title>
      <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #F6F7F5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; color: #1C2321; }
        .card { background: white; padding: 40px 32px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); width: 100%; max-width: 340px; text-align: center; border: 1px solid #DDE1DA; }
        h1 { font-size: 20px; margin-top: 0; margin-bottom: 8px; color: #1C2321; }
        p { font-size: 14px; color: #5C665F; margin-bottom: 24px; line-height: 1.5; }
        input { width: 100%; padding: 12px; margin-bottom: 16px; border: 1px solid #DDE1DA; border-radius: 6px; box-sizing: border-box; font-size: 14px; }
        input:focus { outline: none; border-color: #4B7862; box-shadow: 0 0 0 3px rgba(75,120,98,.13); }
        button { width: 100%; padding: 12px; background: #4B7862; color: white; border: none; border-radius: 6px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
        button:hover { background: #3D6350; }
        button:disabled { opacity: 0.6; cursor: not-allowed; }
        #status { margin-top: 16px; font-size: 13px; font-weight: 500; color: #A8453D; }
        
        /* Success Screen Styles */
        #success-screen { display: none; }
        .check-icon { width: 56px; height: 56px; background: rgba(75,120,98,.13); color: #4B7862; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; }
      </style>
    </head>
    <body>
      <div class="card">
        
        <!-- INITIAL FORM -->
        <div id="form-screen">
          <h1>Reset your password</h1>
          <p>Enter your new password below.</p>
          <form id="reset-form">
            <input type="password" id="new-password" placeholder="New Password (min 6 chars)" required minlength="6">
            <button type="submit" id="submit-btn">Update Password</button>
          </form>
          <div id="status"></div>
        </div>

        <!-- SUCCESS CONFIRMATION -->
        <div id="success-screen">
          <div class="check-icon">
            <svg viewBox="0 0 24 24" width="28" height="28" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
          <h1>Password Updated!</h1>
          <p>Your password has been successfully changed. You can now close this tab and log back into the Chrome Extension.</p>
        </div>

      </div>

      <script>
        // Initialize Supabase Client
        const supabaseUrl = 'https://lushkpzfgsazrzkbsxbx.supabase.co';
        const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx1c2hrcHpmZ3NhenJ6a2JzeGJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwNTQ0ODAsImV4cCI6MjEwMzYzMDQ4MH0.Z2A91Jkr0d0M1_DhV49AmU7H6vsNNaJFJWdlqoXPl5c';
        const supabase = window.supabase.createClient(supabaseUrl, supabaseKey);

        document.getElementById('reset-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = document.getElementById('submit-btn');
          const status = document.getElementById('status');
          const newPassword = document.getElementById('new-password').value;

          btn.disabled = true;
          btn.textContent = 'Updating...';
          status.textContent = '';

          // Supabase detects the secure token in the URL automatically
          const { error } = await supabase.auth.updateUser({ password: newPassword });

          if (error) {
            status.textContent = "Error: " + error.message;
            btn.disabled = false;
            btn.textContent = 'Update Password';
          } else {
            // Hide form and show success confirmation
            document.getElementById('form-screen').style.display = 'none';
            document.getElementById('success-screen').style.display = 'block';
          }
        });
      </script>
    </body>
    </html>
  `);
});
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
