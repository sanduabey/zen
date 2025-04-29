// app/api/chat/route.ts
import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

// Initialize OpenAI client using the API key from environment variables
// Ensure OPENAI_API_KEY is set in your .env.local file
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Define the structure for conversation history messages expected by the API
interface ApiChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// POST handler for the /api/chat endpoint
export async function POST(request: NextRequest) {
  try {
    // --- 1. Extract Audio and History from FormData ---
    const formData = await request.formData();
    const audioFile = formData.get('audio') as File | null; // Get the audio file
    const historyString = formData.get('history') as string | null; // Get conversation history string
    const conversationHistory: ApiChatMessage[] = historyString ? JSON.parse(historyString) : []; // Parse history

    // Validate if audio file exists
    if (!audioFile) {
      console.error('API Error: No audio file received in FormData.');
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 });
    }

    console.log(`API: Received audio file: ${audioFile.name}, Size: ${audioFile.size}, Type: ${audioFile.type}`);
    console.log('API: Received history:', conversationHistory);

    // Convert the audio file Blob/File into a Buffer for the OpenAI SDK
    const audioBuffer = Buffer.from(await audioFile.arrayBuffer());

    // --- 2. Speech-to-Text (STT) using OpenAI Whisper ---
    console.log('API: Transcribing audio...');
    let userTranscript = '';
    try {

      console.log("Hello: File",audioFile)
      const transcription = await openai.audio.transcriptions.create({
        model: 'whisper-1', // Specify the Whisper model
        file: audioFile
        // language: 'en', // Optional: Specify language code (e.g., 'en') if known
      });
      userTranscript = transcription.text;
      console.log('API: Transcription successful:', userTranscript);
    } catch (sttError: any) {
        console.error("API Error: OpenAI STT failed.", sttError?.message);
        // Handle STT failure - provide a specific message back to the user
        userTranscript = "[Audio could not be transcribed]";
        // Note: We proceed to generate TTS for an error message below
    }

    // Handle cases where transcription might be empty or failed
    if (!userTranscript || userTranscript.trim().length < 1 || userTranscript === "[Audio could not be transcribed]") {
        const isTranscriptionError = userTranscript === "[Audio could not be transcribed]";
        const errorMessage = isTranscriptionError
            ? "Sorry, I couldn't understand the audio. Please try again."
            : "Sorry, I didn't catch that. Could you please speak clearly?";
        console.log(`API: ${isTranscriptionError ? 'Transcription failed' : 'Transcription empty'}. Sending clarification message.`);

        // Generate TTS for the error/clarification message
        try {
            const errorTtsResponse = await openai.audio.speech.create({
                model: 'tts-1',
                voice: 'alloy', // Choose a voice for the error message
                input: errorMessage,
                response_format: 'mp3', // Specify desired audio format
            });
            const errorTtsAudioBuffer = Buffer.from(await errorTtsResponse.arrayBuffer());
            const errorAudioBase64 = errorTtsAudioBuffer.toString('base64');

            // Return the clarification message and its audio
            return NextResponse.json({
                userTranscript: userTranscript || "", // Send back the (empty/error) transcript
                llmTextResponse: errorMessage,
                audioBase64: errorAudioBase64, // Base64 encoded audio string for the error
            }, { status: 200 }); // Status 200 as we handled the condition gracefully

        } catch (ttsError: any) {
             console.error("API Error: OpenAI TTS failed (for empty/failed transcript).", ttsError?.message);
             // Fallback if TTS fails even for the error message
             return NextResponse.json({
                userTranscript: userTranscript || "",
                llmTextResponse: errorMessage, // Send text only
                audioBase64: null,
            }, { status: 200 });
        }
    }


    // --- 3. LLM Chat Completion using OpenAI GPT ---
    console.log('API: Getting LLM response...');
    // Prepare messages for the chat API, including system prompt and history
    const messages: ApiChatMessage[] = [
      { role: 'system', content: 'You are a helpful and concise voice assistant. Respond clearly and naturally.' }, // System prompt
      ...conversationHistory, // Add previous messages from the conversation
      { role: 'user', content: userTranscript }, // Add the latest user transcription
    ];

    let llmTextResponse = '';
    try {
        const chatCompletion = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo', // Or 'gpt-4o', 'gpt-4-turbo' etc.
          messages: messages,
          // max_tokens: 150, // Optional: Limit response length if needed
        });
        // Safely access the response content
        llmTextResponse = chatCompletion.choices[0]?.message?.content?.trim() || '';
        if (!llmTextResponse) {
            llmTextResponse = 'Sorry, I could not generate a response at this moment.';
            console.log('API Warning: LLM returned empty content.');
        } else {
             console.log('API: LLM Response generated:', llmTextResponse);
        }
    } catch (llmError: any) {
        console.error("API Error: OpenAI LLM failed.", llmError?.message);
        llmTextResponse = "Sorry, I encountered an error while processing your request.";
        // We will still try to synthesize this error message below
    }


    // --- 4. Text-to-Speech (TTS) using OpenAI TTS ---
    console.log('API: Synthesizing speech for LLM response...');
    let audioBase64: string | null = null;
    if (llmTextResponse) { // Only synthesize if there is text content
        try {
            const ttsResponse = await openai.audio.speech.create({
              model: 'tts-1',       // Specify TTS model (tts-1 or tts-1-hd)
              voice: 'nova',       // Choose a voice (alloy, echo, fable, onyx, nova, shimmer)
              input: llmTextResponse, // Text to synthesize
              response_format: 'mp3', // Desired audio format (mp3, opus, aac, flac)
            });

            // Convert the response stream (ArrayBuffer) to a Buffer, then to Base64
            const ttsAudioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
            audioBase64 = ttsAudioBuffer.toString('base64');
            console.log('API: Speech synthesized successfully.');
        } catch (ttsError: any) {
            console.error("API Error: OpenAI TTS failed.", ttsError?.message);
            // If TTS fails, we'll send the text response without audio
            audioBase64 = null; // Ensure it's null if TTS failed
        }
    } else {
        console.log("API: Skipping TTS because LLM response was empty.");
    }


    // --- 5. Send Response to Frontend ---
    // Return the user's transcription, the LLM's text response, and the Base64 encoded audio
    return NextResponse.json({
      userTranscript: userTranscript,
      llmTextResponse: llmTextResponse,
      audioBase64: audioBase64,
    }, { status: 200 });

  } catch (error: any) {
    // Catch any unexpected errors during the process
    console.error('API Error: Unhandled exception in POST /api/chat.', error);
    // Provide a generic error response to the client
    return NextResponse.json({ error: 'Failed to process audio chat', details: error.message || 'Unknown server error' }, { status: 500 });
  }
}
