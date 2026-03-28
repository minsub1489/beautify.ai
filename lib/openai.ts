type GeminiPart = {
  text?: string;
  inline_data?: {
    mime_type: string;
    data: string;
  };
};

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

export const GEMINI_MODELS = {
  text: process.env.GEMINI_TEXT_MODEL || 'gemini-2.0-flash-lite',
  reasoning: process.env.GEMINI_REASONING_MODEL || 'gemini-2.0-flash',
  transcription: process.env.GEMINI_TRANSCRIBE_MODEL || 'gemini-2.0-flash',
} as const;

export const OPENROUTER_MODELS = {
  text: process.env.OPENROUTER_TEXT_MODEL || 'openai/gpt-4o-mini',
  reasoning: process.env.OPENROUTER_REASONING_MODEL || 'openai/gpt-4.1-mini',
} as const;

export const OPENAI_MODELS = {
  text: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
  reasoning: process.env.OPENAI_REASONING_MODEL || 'gpt-4o-mini',
} as const;

function getApiKey() {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw new Error('GEMINI_API_KEY가 비어 있습니다. .env에 Gemini API 키를 설정해 주세요.');
  }
  return key;
}

function extractCandidateText(payload: any) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractOpenRouterText(payload: any) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function getOpenRouterKey() {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  return key || '';
}

function getOpenAIKey() {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key || '';
}

function shouldFallbackToOpenRouter(error: unknown) {
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : undefined;

  const message = typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message?: unknown }).message ?? '')
    : '';

  return (
    status === 429 ||
    status === 401 ||
    status === 403 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /quota|billing|rate limit|RESOURCE_EXHAUSTED|api key|permission|GEMINI_API_KEY/i.test(message)
  );
}

async function openRouterGenerate(params: {
  model: string;
  prompt: string;
  temperature?: number;
}) {
  const apiKey = getOpenRouterKey();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY가 비어 있습니다.');
  }

  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model,
      temperature: params.temperature ?? 0.2,
      messages: [{ role: 'user', content: params.prompt }],
    }),
  });

  const raw = await response.text();
  let parsed: any = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const message = parsed?.error?.message || raw || `OpenRouter API 오류 (status ${response.status})`;
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  const text = extractOpenRouterText(parsed);
  if (!text) throw new Error('OpenRouter 응답 텍스트가 비어 있습니다.');
  return text;
}

async function openAIGenerate(params: {
  model: string;
  prompt: string;
  temperature?: number;
}) {
  const apiKey = getOpenAIKey();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY가 비어 있습니다.');
  }

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model,
      temperature: params.temperature ?? 0.2,
      messages: [{ role: 'user', content: params.prompt }],
    }),
  });

  const raw = await response.text();
  let parsed: any = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const message = parsed?.error?.message || raw || `OpenAI API 오류 (status ${response.status})`;
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) {
    return content.trim();
  }
  throw new Error('OpenAI 응답 텍스트가 비어 있습니다.');
}

async function geminiGenerate(params: {
  model: string;
  parts: GeminiPart[];
  responseMimeType?: 'application/json' | 'text/plain';
  responseSchema?: unknown;
  temperature?: number;
}) {
  const apiKey = getApiKey();
  const response = await fetch(`${GEMINI_API_URL}/${params.model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: params.parts }],
      generationConfig: {
        temperature: params.temperature ?? 0.2,
        responseMimeType: params.responseMimeType || 'text/plain',
        responseSchema: params.responseSchema,
      },
    }),
  });

  const raw = await response.text();
  let parsed: any = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const message = parsed?.error?.message || raw || `Gemini API 오류 (status ${response.status})`;
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  return parsed;
}

export async function generateGeminiJson<T>(params: {
  model: string;
  prompt: string;
  schema: unknown;
}) {
  try {
    const parsed = await geminiGenerate({
      model: params.model,
      parts: [{ text: params.prompt }],
      responseMimeType: 'application/json',
      responseSchema: params.schema,
      temperature: 0.1,
    });

    const text = extractCandidateText(parsed);
    if (!text) {
      throw new Error('Gemini 응답에서 JSON 텍스트를 찾지 못했습니다.');
    }

    return JSON.parse(text) as T;
  } catch (error) {
    if (!shouldFallbackToOpenRouter(error)) {
      throw error;
    }

    const fallbackPrompt = `${params.prompt}

반드시 아래 JSON 스키마를 지켜 유효한 JSON만 출력하라:
${JSON.stringify(params.schema)}
`;
    const fallbackErrors: Error[] = [];
    if (getOpenAIKey()) {
      try {
        const text = await openAIGenerate({
          model: OPENAI_MODELS.reasoning,
          prompt: fallbackPrompt,
          temperature: 0.1,
        });
        return JSON.parse(text) as T;
      } catch (fallbackError) {
        fallbackErrors.push(
          fallbackError instanceof Error
            ? fallbackError
            : new Error('OpenAI 폴백 실패'),
        );
      }
    }

    if (getOpenRouterKey()) {
      try {
        const text = await openRouterGenerate({
          model: OPENROUTER_MODELS.reasoning,
          prompt: fallbackPrompt,
          temperature: 0.1,
        });
        return JSON.parse(text) as T;
      } catch (fallbackError) {
        fallbackErrors.push(
          fallbackError instanceof Error
            ? fallbackError
            : new Error('OpenRouter 폴백 실패'),
        );
      }
    }

    if (fallbackErrors.length > 0) {
      throw fallbackErrors[fallbackErrors.length - 1];
    }
    throw error;
  }
}

export async function generateGeminiText(params: {
  model: string;
  parts: GeminiPart[];
  temperature?: number;
}) {
  try {
    const parsed = await geminiGenerate({
      model: params.model,
      parts: params.parts,
      responseMimeType: 'text/plain',
      temperature: params.temperature ?? 0.2,
    });
    const text = extractCandidateText(parsed);
    if (!text) throw new Error('Gemini 응답 텍스트가 비어 있습니다.');
    return text;
  } catch (error) {
    if (!shouldFallbackToOpenRouter(error)) {
      throw error;
    }

    const mergedPrompt = params.parts
      .map((part) => part.text || '')
      .filter(Boolean)
      .join('\n');
    const fallbackErrors: Error[] = [];

    if (getOpenAIKey()) {
      try {
        return await openAIGenerate({
          model: OPENAI_MODELS.text,
          prompt: mergedPrompt,
          temperature: params.temperature ?? 0.2,
        });
      } catch (fallbackError) {
        fallbackErrors.push(
          fallbackError instanceof Error
            ? fallbackError
            : new Error('OpenAI 폴백 실패'),
        );
      }
    }

    if (getOpenRouterKey()) {
      try {
        return await openRouterGenerate({
          model: OPENROUTER_MODELS.text,
          prompt: mergedPrompt,
          temperature: params.temperature ?? 0.2,
        });
      } catch (fallbackError) {
        fallbackErrors.push(
          fallbackError instanceof Error
            ? fallbackError
            : new Error('OpenRouter 폴백 실패'),
        );
      }
    }

    if (fallbackErrors.length > 0) {
      throw fallbackErrors[fallbackErrors.length - 1];
    }
    throw error;
  }
}

export function toUserFacingGeminiError(error: unknown) {
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : undefined;

  const message = typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message?: unknown }).message ?? '')
    : '';

  if (status === 429 || /quota|billing|rate limit|RESOURCE_EXHAUSTED/i.test(message)) {
    return 'AI API 한도를 초과했습니다. Gemini/OpenAI/OpenRouter 키와 결제 상태를 확인해 주세요.';
  }
  if (status === 401 || status === 403 || /API key not valid|permission|invalid_api_key|Incorrect API key/i.test(message)) {
    return 'AI API 키 또는 권한 설정을 확인해 주세요. (.env의 GEMINI_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY)';
  }
  if (status === 400) {
    return 'AI 요청 형식이 올바르지 않습니다. 입력 데이터와 모델 설정을 확인해 주세요.';
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return 'AI 서버가 일시적으로 불안정합니다. 잠시 후 다시 시도해 주세요.';
  }

  return message || 'Gemini 요청 중 오류가 발생했습니다.';
}
