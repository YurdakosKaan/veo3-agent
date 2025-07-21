import { z } from 'zod'
import { Agent } from '@openserv-labs/sdk'
import 'dotenv/config'
import { setTimeout as sleep } from 'timers/promises'
import fetch from 'node-fetch'
import { GoogleGenAI } from "@google/genai"
import { Readable } from "stream"
import axios from 'axios'

// Mock Gemini API response for development/testing
// const mockGeminiResponse = {
//   response: {
//     generateVideoResponse: {
//       generatedSamples: [
//         {
//           video: {
//             uri: "https://generativelanguage.googleapis.com/v1beta/files/d3orw066lry6:download?alt=media&key=AIzaSyCD34HDd3U5OLvMBX-QdN15Cg3pOWsG_AI"
//           }
//         }
//       ]
//     }
//   }
// };

// Create the agent
const agent = new Agent({
  systemPrompt: 'You are an agent that generates videos using Google Gemini Veo 3.'
})

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Add Veo 3 video generation capability
agent.addCapability({
  name: 'generateVideo',
  description: 'Generates a video using Google Gemini Veo 3 from a text prompt',
  schema: z.object({
    prompt: z.string()
  }),
  async run({ args, action }) {
    // 1. Generate video
    let operation = await ai.models.generateVideos({
      model: "veo-3.0-generate-preview",
      prompt: args.prompt,
      config: {
        personGeneration: "allow_all",
        aspectRatio: "16:9",
      },
    });

    // 2. Poll for completion
    while (!operation.done) {
      await new Promise((resolve) => setTimeout(resolve, 10000));
      operation = await ai.operations.getVideosOperation({
        operation: operation,
      });
    }

    // 3. Get video URI
    const video = operation.response?.generatedVideos?.[0]?.video?.uri;
    if (!video) throw new Error('No video generated: ' + JSON.stringify(operation));

    // 4. Download video as buffer
    const resp = await fetch(`${video}&key=${process.env.GEMINI_API_KEY}`);
    if (!resp.ok) throw new Error('Failed to download video from Google API');
    const videoBuffer = Buffer.from(await resp.arrayBuffer());

    // 5. Upload to workspace files (same as before)
    if (!action || !action.workspace || !action.workspace.id) {
      throw new Error('Missing workspace context for file upload');
    }
    const workspaceId = action.workspace.id;
    const path = `veo3-video-${Date.now()}.mp4`;
    const uploaded = await agent.uploadFile({
      workspaceId,
      path,
      file: videoBuffer,
    });

    // 6. Report usage (updated per Erkin's suggestion)
    if (action && action.type === 'do-task') {
      const taskId = action.task.id;
      const workspaceId = action.workspace.id;
      const BASE_URL = 'https://api.openserv.ai';
      const { data } = await axios.post(
        `${BASE_URL}/workspaces/${workspaceId}/usage-record`,
        {
          taskId: taskId,
          triggerType: 'task',
          serviceCost: 8 * 100 * 1e6,
        },
        {
          headers: {
            'x-openserv-key': process.env.OPENSERV_API_KEY
          }
        }
      );
      console.log('data', data);
    }

    // 7. Return only the OpenServ workspace file link (no Gemini link for security)
    return `Video generated and uploaded: ${uploaded.url}`;
  }
});

agent.start()