import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      aiClient = new GoogleGenAI({ apiKey });
    }
  }
  return aiClient;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Route: Health Check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'Fundisha Educational Platform' });
  });

  // API Route: AI Tutor Backend
  app.post('/api/ai-tutor', async (req, res) => {
    const { prompt, context } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Prompt is required.' });
    }

    const classLevel = context?.classLevel || 'Secondary School';
    const subject = context?.subject || 'General Education';
    const topic = context?.topic || '';

    try {
      const ai = getGeminiClient();
      if (!ai) {
        // Fallback if API key is not yet configured in environment
        return res.json({
          reply: `Here is a study breakdown for **${subject}** (${classLevel}):\n\n` +
                 `When answering questions on this topic in UNEB examinations, always focus on stating foundational principles clearly, showing full step-by-step working, and using precise scientific or analytical terminology.\n\n` +
                 `*Note: Connect the GEMINI_API_KEY in the platform settings to unlock live real-time conversational AI explanations.*`
        });
      }

      const systemInstruction = 
        `You are the Fundisha AI Study Companion, an expert and encouraging educational tutor specifically designed for Ugandan secondary school students (Senior 1 to Senior 6).\n` +
        `You follow the National Curriculum Development Centre (NCDC) and Uganda National Examinations Board (UCE & UACE) syllabus guidelines.\n` +
        `Current student context: Class Level: ${classLevel}, Subject: ${subject}${topic ? `, Topic: ${topic}` : ''}.\n\n` +
        `Guidelines:\n` +
        `1. Explain concepts step-by-step clearly and concisely with simple language suitable for a Ugandan secondary student.\n` +
        `2. Use authentic real-world Ugandan examples (e.g. Kampala traffic for inertia, River Nile or Lake Victoria for water resources, Ugandan agriculture for biology/soil science, 1900 Buganda agreement for history).\n` +
        `3. Provide UNEB examination marking tips and common pitfalls to avoid.\n` +
        `4. Format with clean Markdown headers, bullet points, and bold terms for readability.\n` +
        `5. Never make up syllabus requirements; encourage deep understanding and academic confidence.`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          systemInstruction,
          temperature: 0.7
        }
      });

      res.json({ reply: response.text || 'I could not generate a response. Please try rephrasing your inquiry.' });
    } catch (error: any) {
      console.error('AI Tutor generation error:', error);
      res.status(500).json({
        error: 'Failed to process inquiry with AI companion.',
        details: error?.message || 'Server error'
      });
    }
  });

  // Vite middleware in dev; static file serving in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Fundisha full-stack server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
