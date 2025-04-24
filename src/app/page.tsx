// app/page.tsx
'use client'; // Required for hooks and event handlers in App Router

import React, { useState, useRef, useEffect, useCallback } from 'react';

// Define the structure for a message in the conversation history
interface ConversationMessage {
  role: 'You' | 'Assistant' | 'System' | 'Error'; // Added Error role
  text: string;
  audio?: string | null; // Base64 audio data, optional (only for Assistant)
}

// Define the structure for API messages (for sending history)
interface ApiChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}


export default function HomePage() {
  // State variables
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false); // For API call in progress
  const [conversation, setConversation] = useState<ConversationMessage[]>([]);
  const [status, setStatus] = useState<string>('Click Start Recording'); // User feedback

  // Refs for managing media recording and audio playback
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]); // Store audio data chunks
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null); // Ref for the <audio> element
  const mediaStreamRef = useRef<MediaStream | null>(null); // Ref to hold the media stream

  // --- Audio Recording Handlers ---

  const startRecording = useCallback(async () => {
    // Request microphone access
    if (isRecording) return; // Prevent starting if already recording
    try {
      // Ensure previous stream is stopped before getting a new one
      if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach(track => track.stop());
          console.log("Previous media stream stopped.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream; // Store the stream reference
      setStatus('Microphone access granted. Initializing recorder...');

      // Determine a supported MIME type for the recording
      const supportedTypes = [
        'audio/webm;codecs=opus', // Preferred for quality and compatibility
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4', // May require specific codecs, less common for recording
        'audio/aac', // Sometimes available
      ];
      const mimeType = supportedTypes.find(type => MediaRecorder.isTypeSupported(type));

      if (!mimeType) {
        setStatus('Error: No supported audio format found for recording.');
        console.error('No supported MIME type found for MediaRecorder');
        // Clean up stream tracks if necessary
        stream.getTracks().forEach(track => track.stop());
        mediaStreamRef.current = null;
        return;
      }
      console.log("Using MIME type for recording:", mimeType);

      // Create MediaRecorder instance
      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = []; // Clear any previous audio chunks

      // Event handler for when audio data is available
      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      // Event handler for when recording stops
      mediaRecorderRef.current.onstop = async () => {
        setIsLoading(true); // Indicate processing has started
        setStatus('Recording stopped. Processing audio...');

        // Stop the media stream tracks *after* recording stops and before sending data
        // This releases the microphone promptly
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach(track => track.stop());
            console.log("Microphone stream stopped after recording.");
            mediaStreamRef.current = null; // Clear the ref
        }

        // Check if any audio was recorded
        if (audioChunksRef.current.length === 0) {
            console.log("No audio data recorded.");
            setStatus("No audio detected. Please try recording again.");
            setIsLoading(false);
            setIsRecording(false); // Ensure state is consistent
            return; // Exit if no audio chunks
        }


        // Create a Blob from the collected audio chunks
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        console.log(`Created audio blob: size=${audioBlob.size}, type=${audioBlob.type}`);


        // --- Prepare data for API ---
        const formData = new FormData();
        // Append the audio blob as a file
        // Use a consistent filename extension based on the mimeType
        const fileExtension = mimeType.split('/')[1].split(';')[0]; // e.g., 'webm' or 'ogg'
        formData.append('audio', audioBlob, `recording.${fileExtension}`);

        // Append recent conversation history (formatted for the API)
        // Limit history to avoid overly large requests
        const historyForApi: ApiChatMessage[] = conversation
          .slice(-8) // Send last 8 messages (adjust as needed)
          .filter(msg => msg.role === 'You' || msg.role === 'Assistant') // Only user/assistant messages
          .map(({ role, text }) => ({
            role: role === 'You' ? 'user' : 'assistant',
            content: text,
          }));
        formData.append('history', JSON.stringify(historyForApi));
        console.log("Sending history to API:", historyForApi);

        // --- Call the Backend API ---
        try {
          const response = await fetch('/api/chat', {
            method: 'POST',
            body: formData,
            // 'Content-Type': 'multipart/form-data' is set automatically by fetch for FormData
          });

          // No need to stop tracks here, already done above


          if (!response.ok) {
            // Handle HTTP errors (e.g., 400, 500) more robustly
            let errorMsg = `API request failed with status ${response.status}`;
            try {
                const errorData = await response.json();
                console.error('API Error Response Body:', errorData);
                errorMsg = errorData.error || errorData.details || errorMsg;
            } catch (jsonError) {
                // If the response is not JSON, use the status text
                errorMsg = `${errorMsg}: ${response.statusText}`;
                console.error('API Error Response was not JSON.');
            }
            throw new Error(errorMsg);
          }

          // Process successful response
          const data = await response.json();
          setStatus('Received response.');
          console.log('API Response Data:', data);

          // Validate received data (basic check)
          if (typeof data.userTranscript !== 'string' || typeof data.llmTextResponse !== 'string') {
              throw new Error("Invalid response format received from API.");
          }

          // Update conversation state with user transcription and assistant response
          const newUserMessage: ConversationMessage = { role: 'You', text: data.userTranscript || "(No transcription)" };
          const newAssistantMessage: ConversationMessage = { role: 'Assistant', text: data.llmTextResponse, audio: data.audioBase64 }; // audio can be null

          setConversation(prev => [...prev, newUserMessage, newAssistantMessage]);

          // Play the assistant's audio response if available
          if (data.audioBase64 && audioPlayerRef.current) {
            const audioSrc = `data:audio/mp3;base64,${data.audioBase64}`; // Assuming MP3 from backend
            audioPlayerRef.current.src = audioSrc;
            // Attempt to play audio, catching potential errors (e.g., user interaction needed)
            audioPlayerRef.current.play().then(() => {
                console.log("Assistant audio playback started.");
                setStatus("Playing response... Click Start Recording when ready.");
            }).catch(e => {
                console.error("Error playing audio automatically:", e);
                // Inform user how to play manually if autoplay fails
                setStatus("Received response. Click 'Replay Audio' to listen.");
            });
          } else if (data.llmTextResponse) {
             // If there's text but no audio (e.g., TTS failed on backend)
             setStatus("Received text response. Click Start Recording when ready.");
             console.log("Received text response without audio.");
          } else {
             // If response is minimal (e.g., only empty transcription)
             setStatus("Processing complete. Click Start Recording.");
          }

        } catch (error: any) {
          console.error('Error sending/processing audio:', error);
          setStatus(`Error: ${error.message}`);
          // Add an error message to the conversation history
          setConversation(prev => [...prev, { role: 'Error', text: `Processing failed: ${error.message}` }]);
           // Ensure stream tracks are stopped even on error (should be already stopped, but as fallback)
           if (mediaStreamRef.current) {
               mediaStreamRef.current.getTracks().forEach(track => track.stop());
               mediaStreamRef.current = null;
           }
        } finally {
          setIsLoading(false); // Processing finished (success or error)
          setIsRecording(false); // Ensure recording state is reset
          // Reset status only if it wasn't set to an error or specific playback info
          if (!status.startsWith('Error') && !status.includes('Replay') && !status.includes('Playing')) {
             setStatus('Ready. Click Start Recording.');
          }
          // Clear audio chunks for the next recording
          audioChunksRef.current = [];
        }
      };

      // Add error handling for the MediaRecorder itself
      mediaRecorderRef.current.onerror = (event: Event) => {
          console.error("MediaRecorder Error:", event);
          setStatus("Error during recording. Please try again.");
          // Stop tracks and reset state
          if (mediaStreamRef.current) {
              mediaStreamRef.current.getTracks().forEach(track => track.stop());
              mediaStreamRef.current = null;
          }
          setIsRecording(false);
          setIsLoading(false);
      };


      // Start recording
      mediaRecorderRef.current.start();
      setIsRecording(true);
      setStatus('Recording... Click Stop Recording');

    } catch (err: any) {
      console.error('Error accessing microphone or starting recording:', err);
      let errMsg = 'Could not access microphone.';
      if (err.name === 'NotAllowedError') {
          errMsg = 'Microphone permission denied. Please grant permission in browser settings.';
      } else if (err.name === 'NotFoundError') {
          errMsg = 'No microphone found. Please ensure a microphone is connected and enabled.';
      } else {
          errMsg = `${errMsg} ${err.message}`;
      }
      setStatus(`Error: ${errMsg}`);
      setIsRecording(false); // Ensure recording state is false
      // Ensure stream is cleaned up if partially obtained
       if (mediaStreamRef.current) {
           mediaStreamRef.current.getTracks().forEach(track => track.stop());
           mediaStreamRef.current = null;
       }
    }
  }, [isRecording, conversation, status]); // Dependencies for useCallback

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop(); // Triggers the 'onstop' event handler
      // State updates (isRecording=false, isLoading=true) are handled in onstop
      setStatus("Stopping recording..."); // Give immediate feedback
    } else {
        console.log("Stop recording called but not in recording state.");
    }
  }, []); // No dependencies needed here

  // --- Effect for Cleanup ---
  useEffect(() => {
    // Cleanup function runs when the component unmounts
    return () => {
      console.log("Cleanup effect running on unmount.");
      // Stop recording if active
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
        console.log("Stopped active recording on unmount.");
      }
      // Stop any playing audio and release audio element resources
      if (audioPlayerRef.current) {
        audioPlayerRef.current.pause();
        audioPlayerRef.current.src = ""; // Clear source
        console.log("Paused audio player on unmount.");
      }
      // Ensure microphone stream is released
      if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach(track => track.stop());
          console.log("Stopped media stream on unmount.");
          mediaStreamRef.current = null;
      }
    };
  }, []); // Empty dependency array ensures this runs only on mount and unmount

  // --- Replay Audio Function ---
   const replayAudio = (audioBase64: string | null | undefined) => {
        if (audioBase64 && audioPlayerRef.current) {
            const audioSrc = `data:audio/mp3;base64,${audioBase64}`;
            audioPlayerRef.current.src = audioSrc;
            audioPlayerRef.current.play().catch(e => console.error("Error replaying audio:", e));
        } else {
            console.log("Replay called but no audio data available.");
        }
   };

  // --- Render Component ---
  return (
    <div className="container mx-auto max-w-3xl p-4 sm:p-6 font-sans">
      <h1 className="text-2xl sm:text-3xl font-bold text-center mb-6 text-gray-800">Verbal Chat with LLM</h1>

      {/* Status Display */}
      <p className="text-center text-gray-600 mb-4 min-h-[1.5em] px-2">{status}</p>

      {/* Recording Controls */}
      <div className="flex flex-col sm:flex-row justify-center items-center gap-4 mb-6">
        <button
          onClick={startRecording}
          disabled={isRecording || isLoading}
          className="w-full sm:w-auto px-6 py-3 bg-blue-600 text-white rounded-lg shadow-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 disabled:bg-gray-400 disabled:cursor-not-allowed transition-all duration-150 ease-in-out text-lg font-medium"
          aria-label="Start recording audio"
        >
          {isRecording ? (
             <span className="flex items-center justify-center">
                <span className="animate-pulse mr-2">🔴</span> Recording...
             </span>
          ) : (
             'Start Recording'
          )}
        </button>
        <button
          onClick={stopRecording}
          disabled={!isRecording || isLoading}
          className="w-full sm:w-auto px-6 py-3 bg-red-600 text-white rounded-lg shadow-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-50 disabled:bg-gray-400 disabled:cursor-not-allowed transition-all duration-150 ease-in-out text-lg font-medium"
          aria-label="Stop recording audio"
        >
          Stop Recording
        </button>
      </div>

      {/* Loading Indicator */}
      {isLoading && (
          <div className="flex justify-center items-center mb-4 text-blue-600">
              <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Processing audio...
          </div>
       )}

      {/* Conversation History */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 sm:p-6 h-[50vh] overflow-y-auto shadow-md">
        <h2 className="text-xl font-semibold mb-4 text-gray-700 border-b pb-2">Conversation</h2>
        {conversation.length === 0 ? (
          <p className="text-gray-500 italic text-center mt-8">Your conversation will appear here.</p>
        ) : (
          <div className="space-y-4">
            {conversation.map((msg, index) => (
              <div
                key={index}
                className={`p-3 rounded-lg shadow-sm text-sm sm:text-base ${
                  msg.role === 'You' ? 'bg-blue-50 text-blue-900 ml-auto max-w-[85%] sm:max-w-[75%]' : // User messages align right (visually)
                  msg.role === 'Assistant' ? 'bg-green-50 text-green-900 mr-auto max-w-[85%] sm:max-w-[75%]' : // Assistant messages align left (visually)
                  'bg-red-50 text-red-900 mr-auto max-w-[85%] sm:max-w-[75%]' // Error messages align left
                }`}
              >
                <strong className="font-semibold block mb-1">{msg.role}:</strong>
                <span className="ml-1 whitespace-pre-wrap">{msg.text}</span>
                {/* Replay Button for Assistant messages with audio */}
                {msg.role === 'Assistant' && msg.audio && (
                   <button
                      onClick={() => replayAudio(msg.audio)}
                      disabled={isLoading}
                      className="ml-1 mt-2 px-2 py-1 text-xs bg-gray-200 text-gray-800 rounded hover:bg-gray-300 focus:outline-none focus:ring-1 focus:ring-gray-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      aria-label="Replay assistant audio"
                   >
                     Replay Audio
                   </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Hidden Audio Player Element */}
      {/* Added controls temporarily for debugging if needed, otherwise keep hidden */}
      <audio ref={audioPlayerRef} className="hidden" controls={false} />
    </div>
  );
}
