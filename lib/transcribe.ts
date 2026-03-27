import { GEMINI_MODELS, generateGeminiText, toUserFacingGeminiError } from './openai';

export async function transcribeAudioFromBuffer(buffer: Buffer, filename: string, mimeType: string) {
  try {
    const transcript = await generateGeminiText({
      model: GEMINI_MODELS.transcription,
      parts: [
        { text: `다음 오디오를 한국어로 정확히 전사해라. 화자 분리는 하지 말고 순수 전사 텍스트만 출력해라. 파일명: ${filename}` },
        { inline_data: { mime_type: mimeType || 'audio/mpeg', data: buffer.toString('base64') } },
      ],
      temperature: 0,
    });
    return transcript.trim();
  } catch (error) {
    throw new Error(toUserFacingGeminiError(error));
  }
}
