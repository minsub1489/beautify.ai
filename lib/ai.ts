import { GEMINI_MODELS, generateGeminiJson, toUserFacingGeminiError } from './openai';
import type { GenerationResult, QuizQuestion } from './types';

const LOW_TOKEN_MODE = (process.env.AI_LOW_TOKEN_MODE || '').toLowerCase() === 'true';

function toInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function compactContext(text: string, maxChars: number, keywordBias = true) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;

  const sentences = normalized
    .split(/(?<=[.!?])\s+|(?<=다\.|요\.|니다\.)\s+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!sentences.length) return normalized.slice(0, maxChars);

  const priority = /핵심|중요|시험|주의|정의|공식|비교|결론|요약|포인트|알고리즘|모델|함수|증명|예시|graph|timeline|flow|table/i;
  const ranked = [...sentences].sort((a, b) => {
    const aScore = (keywordBias && priority.test(a) ? 80 : 0) + Math.min(60, a.length);
    const bScore = (keywordBias && priority.test(b) ? 80 : 0) + Math.min(60, b.length);
    return bScore - aScore;
  });

  const picked: string[] = [];
  let used = 0;
  for (const line of ranked) {
    if (used + line.length + 1 > maxChars) continue;
    picked.push(line);
    used += line.length + 1;
    if (used >= maxChars * 0.92) break;
  }

  if (!picked.length) return normalized.slice(0, maxChars);
  return picked.join('\n');
}

function splitStudySentences(text: string) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|(?<=다\.|요\.|니다\.)\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 16);
}

function buildQuizEvidence(payload: {
  pdfText: string;
  pdfPages?: { page: number; text: string }[];
  maxPages: number;
  evidencePerPage: number;
  evidenceTextMax: number;
  maxTotalChars: number;
}) {
  const priority = /핵심|중요|시험|정의|원리|과정|비교|주의|공식|결론|요약|포인트|알고리즘|모델|함수|증명|예시|단계|특징|장단점/i;
  const evidenceSources: string[] = [];
  const evidenceLines: string[] = [];
  let used = 0;

  const pages = (payload.pdfPages ?? [])
    .filter((page) => (page.text || '').trim())
    .slice(0, payload.maxPages);

  for (const page of pages) {
    const ranked = splitStudySentences(page.text)
      .sort((a, b) => {
        const aScore = (priority.test(a) ? 80 : 0) + Math.min(60, a.length);
        const bScore = (priority.test(b) ? 80 : 0) + Math.min(60, b.length);
        return bScore - aScore;
      })
      .slice(0, payload.evidencePerPage);

    const snippets = ranked.length
      ? ranked
      : [compactContext(page.text, payload.evidenceTextMax, true)].filter(Boolean);

    for (const snippet of snippets) {
      const clipped = compactContext(snippet, payload.evidenceTextMax, false);
      if (!clipped) continue;
      const line = `${page.page}페이지: ${clipped}`;
      if (used + line.length + 1 > payload.maxTotalChars) break;
      evidenceLines.push(`- ${line}`);
      evidenceSources.push(line);
      used += line.length + 1;
    }

    if (used >= payload.maxTotalChars) break;
  }

  if (!evidenceLines.length) {
    const fallback = compactContext(payload.pdfText, Math.min(payload.maxTotalChars, payload.evidenceTextMax * 4));
    if (fallback) {
      evidenceLines.push(`- 1페이지: ${fallback}`);
      evidenceSources.push(`1페이지: ${fallback}`);
    }
  }

  return {
    evidenceText: evidenceLines.join('\n'),
    evidenceSources,
  };
}

function normalizeQuizCompareText(text: string) {
  return (text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/["'`()[\]{}]/g, '')
    .trim();
}

function tokenizeQuizText(text: string) {
  return normalizeQuizCompareText(text)
    .split(/[^a-z0-9가-힣]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function quizTextHasEnoughKorean(text: string) {
  const korean = (text.match(/[가-힣]/g) || []).length;
  return korean >= 2;
}

function sourceLooksGrounded(source: string, evidenceSources: string[]) {
  const normalizedSource = normalizeQuizCompareText(source).replace(/^\d+\s*페이지\s*[:·-]?\s*/i, '');
  if (!normalizedSource) return false;

  return evidenceSources.some((evidence) => {
    const normalizedEvidence = normalizeQuizCompareText(evidence).replace(/^\d+\s*페이지\s*[:·-]?\s*/i, '');
    if (!normalizedEvidence) return false;
    if (normalizedEvidence.includes(normalizedSource) || normalizedSource.includes(normalizedEvidence.slice(0, 24))) {
      return true;
    }

    const tokens = tokenizeQuizText(normalizedSource);
    if (!tokens.length) return false;
    const overlap = tokens.filter((token) => normalizedEvidence.includes(token)).length;
    return overlap >= Math.min(3, tokens.length);
  });
}

type GroundedQuizQuestion = QuizQuestion & {
  concept?: string | null;
  sourcePage?: number | null;
};

function normalizeGroundedQuizQuestions(rawQuestions: GroundedQuizQuestion[]) {
  return rawQuestions.map((item) => {
    const type = item.type === 'ox' || item.type === 'mcq' || item.type === 'short' ? item.type : 'short';
    const sourcePage = Number.isFinite(item.sourcePage) && Number(item.sourcePage) > 0
      ? Math.trunc(Number(item.sourcePage))
      : undefined;
    const source = (item.source || '').trim();
    const sourceWithPage = sourcePage && !/^\d+\s*페이지/i.test(source)
      ? `${sourcePage}페이지: ${source}`
      : source;

    return {
      ...item,
      type,
      question: (item.question || '').trim(),
      answer: (item.answer || '').trim(),
      hint: (item.hint || '').trim(),
      source: sourceWithPage.trim(),
      options: Array.isArray(item.options)
        ? item.options.map((option) => (option || '').trim()).filter(Boolean).slice(0, 4)
        : undefined,
      correctOptionIndex: typeof item.correctOptionIndex === 'number' ? item.correctOptionIndex : undefined,
    };
  });
}

function validateGroundedQuizQuestions(questions: GroundedQuizQuestion[], evidenceSources: string[]) {
  const normalized = normalizeGroundedQuizQuestions(questions);
  const problems: string[] = [];

  if (normalized.length < 4) {
    problems.push('문항 수가 너무 적습니다.');
  }

  for (const [index, item] of normalized.entries()) {
    const label = `${index + 1}번 문제`;
    if (!item.question || !quizTextHasEnoughKorean(item.question)) {
      problems.push(`${label} 질문이 한국어로 충분히 작성되지 않았습니다.`);
    }
    if (!item.answer || (item.type !== 'ox' && !quizTextHasEnoughKorean(item.answer))) {
      problems.push(`${label} 정답이 부정확합니다.`);
    }
    if (!item.hint || !quizTextHasEnoughKorean(item.hint)) {
      problems.push(`${label} 힌트가 비어 있거나 한국어 설명이 부족합니다.`);
    }
    if (!item.source || !sourceLooksGrounded(item.source, evidenceSources)) {
      problems.push(`${label} 출제 근거가 PDF 근거와 맞지 않습니다.`);
    }
    if (/(다음\s*자료|자료\s*문장|자료\s*내용|pdf\s*본문)/i.test(item.question)) {
      problems.push(`${label} 질문이 너무 일반적입니다.`);
    }
    if (item.type === 'ox' && !/^(O|X)$/i.test(item.answer.trim())) {
      problems.push(`${label} OX 정답 형식이 올바르지 않습니다.`);
    }
    if (item.type === 'mcq') {
      if (!item.options || item.options.length !== 4) {
        problems.push(`${label} 4지선다 보기가 정확히 4개가 아닙니다.`);
      }
      if (typeof item.correctOptionIndex !== 'number' || item.correctOptionIndex < 0 || item.correctOptionIndex > 3) {
        problems.push(`${label} 정답 보기 인덱스가 올바르지 않습니다.`);
      }
    }
  }

  return {
    normalized,
    problems,
  };
}

export async function inferSubjectFromMaterials(payload: {
  title: string;
  description?: string;
  pdfText: string;
  transcriptText?: string;
}) {
  try {
    const subjectPdfMax = toInt(process.env.AI_SUBJECT_PDF_MAX_CHARS, LOW_TOKEN_MODE ? 2400 : 7000);
    const subjectTranscriptMax = toInt(process.env.AI_SUBJECT_TRANSCRIPT_MAX_CHARS, LOW_TOKEN_MODE ? 1200 : 3000);

    return await generateGeminiJson<{
      subject: string;
      broadSubject: string;
      confidence: number;
      rationale: string;
    }>({
      model: GEMINI_MODELS.text,
      prompt: `
너는 업로드된 강의 자료를 보고 과목을 분류하는 분석기다.
반드시 JSON만 출력하라.

분류 규칙:
- 가능한 한 구체적인 과목명을 써라. 예: 자료구조, 운영체제, 컴퓨터네트워크, 머신러닝, 딥러닝, 인공지능, 알고리즘, 데이터베이스, 선형대수, 미적분, 한국사, 세계사, 화학, 생명과학, 경제학
- 코딩/AI/딥러닝 자료라면 일반적인 '컴퓨터'보다 더 구체적으로 분류하라.
- 확신이 낮으면 broadSubject에는 넓은 계열(예: 공학, 사회, 자연과학)을 적고 subject는 가장 가능성 높은 과목을 적어라.

입력:
- 제목: ${payload.title}
- 설명: ${payload.description ?? ''}
- PDF 본문: ${compactContext(payload.pdfText, subjectPdfMax)}
- 음성 전사: ${compactContext(payload.transcriptText ?? '', subjectTranscriptMax)}
`,
      schema: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          broadSubject: { type: 'string' },
          confidence: { type: 'number' },
          rationale: { type: 'string' },
        },
        required: ['subject', 'broadSubject', 'confidence', 'rationale'],
      },
    });
  } catch (error) {
    throw new Error(toUserFacingGeminiError(error));
  }
}

export async function generateAnnotatedNotes(payload: {
  subject?: string;
  lectureTitle: string;
  pdfText: string;
  pdfPages?: { page: number; text: string }[];
  transcriptText?: string;
  notionText?: string;
  customNotes?: string;
}): Promise<Pick<GenerationResult, 'summary' | 'examFocus' | 'notesByPage' | 'visuals'>> {
  const generatePdfMax = toInt(process.env.AI_GENERATE_PDF_MAX_CHARS, LOW_TOKEN_MODE ? 4200 : 13000);
  const generateTranscriptMax = toInt(process.env.AI_GENERATE_TRANSCRIPT_MAX_CHARS, LOW_TOKEN_MODE ? 1800 : 6000);
  const generateNotionMax = toInt(process.env.AI_GENERATE_NOTION_MAX_CHARS, LOW_TOKEN_MODE ? 1400 : 5000);
  const generateNotesMax = toInt(process.env.AI_GENERATE_NOTES_MAX_CHARS, LOW_TOKEN_MODE ? 1400 : 5000);
  const pageOutlineMaxPages = toInt(process.env.AI_GENERATE_PAGE_CONTEXT_COUNT, LOW_TOKEN_MODE ? 8 : 12);
  const pageOutlineTextMax = toInt(process.env.AI_GENERATE_PAGE_CONTEXT_MAX_CHARS, LOW_TOKEN_MODE ? 220 : 520);

  const compactedPdf = compactContext(payload.pdfText, generatePdfMax);
  const compactedTranscript = compactContext(payload.transcriptText ?? '', generateTranscriptMax);
  const compactedNotion = compactContext(payload.notionText ?? '', generateNotionMax);
  const compactedCustomNotes = compactContext(payload.customNotes ?? '', generateNotesMax);
  const compactedPageOutline = (payload.pdfPages ?? [])
    .slice(0, pageOutlineMaxPages)
    .map((page) => `- ${page.page}페이지: ${compactContext(page.text, pageOutlineTextMax)}`)
    .filter(Boolean)
    .join('\n');

  const prompt = `
너는 대학생/고등학생용 강의자료 필기 AI다.
목표는 원본 PDF 페이지 위에 직접 삽입되는 짧고 정확한 필기와, 시험 대비용 시각자료를 만드는 것이다.
입력 자료는 비용 최적화를 위해 압축되어 있으니, 핵심 문장 위주로 논리적으로 복원해 정리해라.

과목 자동화 규칙:
- subject가 비어 있거나 '미지정'에 가까우면 PDF/음성/메모 내용을 보고 과목의 성격을 먼저 스스로 추론한 뒤 반영해라.
- 코딩, 알고리즘, 소프트웨어공학, 운영체제, 컴퓨터구조, 데이터베이스, 머신러닝, 딥러닝, 인공지능 자료는 특히 더 잘 설명해야 한다.

반드시 지켜라:
1) 출력은 JSON만.
2) summary에는 자료의 과목/주제를 1문장으로 명확히 드러내라.
3) notesByPage는 페이지별로 ${LOW_TOKEN_MODE ? '1~3줄' : '2~5줄'} 길이의 한국어 필기.
4) examFocus는 시험에 나올 가능성이 높은 포인트.
5) visuals는 최대 ${LOW_TOKEN_MODE ? '1개' : '3개'}.
6) notesByPage.page와 visuals.page는 반드시 실제 PDF 페이지 번호(1부터 시작)를 사용한다.
7) 가능하면 아래 "페이지 개요"를 최우선으로 참고해서 어느 페이지에 어떤 필기/시각자료를 넣을지 정한다.
8) visuals는 새 페이지를 만드는 용도가 아니라, 원본 PDF 페이지 안에 삽입되는 카드형 필기 자료다.
9) 수학/통계/선형대수/미적분이면 formula 또는 graph를 우선 고려한다.
10) 역사면 timeline을 우선 고려한다.
11) 코딩/딥러닝/AI/CS 계열이면 flowchart나 table을 최소 1개 이상 적극 사용한다.
12) 과학/경제/사회면 table 또는 flowchart를 적극 사용한다.
13) 교수자 강조점은 transcript/notion/customNotes를 우선 반영한다.
14) PDF 내용이 부족하면 추측하지 말고 일반화된 안전한 수준으로만 정리한다.
15) 코딩/AI 계열이면 개념 정의뿐 아니라 "입력→처리→출력", 함수 역할, 모델 흐름, 학습 포인트, 자주 틀리는 부분을 강조하라.
16) 딥러닝/AI 계열이면 수식이 있더라도 직관, 손실함수 의미, 역전파/학습 흐름, 모델 비교를 학생이 이해하기 쉽게 바꿔라.
17) 사용자가 메모를 채팅처럼 여러 개 넣었으면 각 메모를 모두 반영하라.
18) formula를 만들 때 expression은 가능한 한 짧고 읽기 쉬운 식/의사수식으로 적고, meaning/example은 학생이 이해하기 쉬운 한국어로 적는다.

입력:
- 과목: ${payload.subject ?? '미지정'}
- 강의 제목: ${payload.lectureTitle}
- PDF 본문: ${compactedPdf}
- 페이지 개요:
${compactedPageOutline || '- 페이지 개요 없음'}
- 음성 전사: ${compactedTranscript}
- 노션 메모: ${compactedNotion}
- 사용자 메모: ${compactedCustomNotes}

JSON 스키마 설명:
summary: 전체 요약
examFocus: string[]
notesByPage: [{page:number, notes:string}]
visuals: [
 {title, page:number, kind:'graph', caption, graph:{xLabel,yLabel,series:[{label,points:[{x:number,y:number,label?:string}]}]}}
 또는
 {title, page:number, kind:'timeline', caption, timeline:{events:[{year,label,detail?}]}}
 또는
 {title, page:number, kind:'table', caption, table:{columns:string[], rows:string[][]}}
 또는
 {title, page:number, kind:'flowchart', caption, flowchart:{nodes:[{id,label}], edges:[{from,to,label?}]}}
 또는
 {title, page:number, kind:'formula', caption, formula:{expression:string, meaning?:string, example?:string}}
]
`;

  try {
    return await generateGeminiJson<Pick<GenerationResult, 'summary' | 'examFocus' | 'notesByPage' | 'visuals'>>({
      model: LOW_TOKEN_MODE ? GEMINI_MODELS.text : GEMINI_MODELS.reasoning,
      prompt,
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          examFocus: { type: 'array', items: { type: 'string' } },
          notesByPage: {
            type: 'array',
            items: {
              type: 'object',
              properties: { page: { type: 'number' }, notes: { type: 'string' } },
              required: ['page', 'notes']
            }
          },
          visuals: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                page: { type: 'number' },
                kind: { type: 'string', enum: ['graph', 'timeline', 'table', 'flowchart', 'formula'] },
                caption: { type: 'string' },
                graph: {
                  anyOf: [
                    { type: 'null' },
                    {
                      type: 'object',
                      properties: {
                        xLabel: { type: 'string' },
                        yLabel: { type: 'string' },
                        series: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              label: { type: 'string' },
                              points: {
                                type: 'array',
                                items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, label: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['x', 'y', 'label'] }
                              }
                            }, required: ['label', 'points']
                          }
                        }
                      }, required: ['xLabel', 'yLabel', 'series']
                    }
                  ]
                },
                timeline: {
                  anyOf: [
                    { type: 'null' },
                    {
                      type: 'object',
                      properties: {
                        events: { type: 'array', items: { type: 'object', properties: { year: { type: 'string' }, label: { type: 'string' }, detail: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['year', 'label', 'detail'] } }
                      }, required: ['events']
                    }
                  ]
                },
                table: {
                  anyOf: [
                    { type: 'null' },
                    {
                      type: 'object',
                      properties: {
                        columns: { type: 'array', items: { type: 'string' } },
                        rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } }
                      }, required: ['columns', 'rows']
                    }
                  ]
                },
                flowchart: {
                  anyOf: [
                    { type: 'null' },
                    {
                      type: 'object',
                      properties: {
                        nodes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'] } },
                        edges: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, label: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['from', 'to', 'label'] } }
                      }, required: ['nodes', 'edges']
                    }
                  ]
                },
                formula: {
                  anyOf: [
                    { type: 'null' },
                    {
                      type: 'object',
                      properties: {
                        expression: { type: 'string' },
                        meaning: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                        example: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                      },
                      required: ['expression', 'meaning', 'example'],
                    }
                  ]
                }
              },
              required: ['title', 'page', 'kind', 'caption', 'graph', 'timeline', 'table', 'flowchart', 'formula']
            }
          }
        },
        required: ['summary', 'examFocus', 'notesByPage', 'visuals']
      },
    });
  } catch (error) {
    throw new Error(toUserFacingGeminiError(error));
  }
}

export async function generatePdfReviewQuestions(payload: {
  subject?: string;
  lectureTitle: string;
  pdfText: string;
  pdfPages?: { page: number; text: string }[];
}): Promise<{ reviewQuestions: QuizQuestion[] }> {
  const generatePdfMax = toInt(process.env.AI_GENERATE_PDF_MAX_CHARS, LOW_TOKEN_MODE ? 4200 : 14000);
  const pageOutlineMaxPages = toInt(process.env.AI_GENERATE_PAGE_CONTEXT_COUNT, LOW_TOKEN_MODE ? 10 : 18);
  const pageOutlineTextMax = toInt(process.env.AI_GENERATE_PAGE_CONTEXT_MAX_CHARS, LOW_TOKEN_MODE ? 260 : 700);
  const evidencePerPage = toInt(process.env.AI_QUIZ_EVIDENCE_PER_PAGE, LOW_TOKEN_MODE ? 2 : 3);
  const evidenceTotalMax = toInt(process.env.AI_QUIZ_EVIDENCE_TOTAL_MAX_CHARS, LOW_TOKEN_MODE ? 3800 : 9000);

  const compactedPdf = compactContext(payload.pdfText, generatePdfMax);
  const compactedPageOutline = (payload.pdfPages ?? [])
    .slice(0, pageOutlineMaxPages)
    .map((page) => `- ${page.page}페이지: ${compactContext(page.text, pageOutlineTextMax)}`)
    .filter(Boolean)
    .join('\n');
  const quizEvidence = buildQuizEvidence({
    pdfText: payload.pdfText,
    pdfPages: payload.pdfPages,
    maxPages: pageOutlineMaxPages,
    evidencePerPage,
    evidenceTextMax: pageOutlineTextMax,
    maxTotalChars: evidenceTotalMax,
  });

  const schema = {
    type: 'object',
    properties: {
      reviewQuestions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['short', 'ox', 'mcq'] },
            concept: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            sourcePage: { anyOf: [{ type: 'number' }, { type: 'null' }] },
            question: { type: 'string' },
            answer: { type: 'string' },
            hint: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            source: { type: 'string' },
            options: {
              anyOf: [
                { type: 'null' },
                { type: 'array', items: { type: 'string' } },
              ],
            },
            correctOptionIndex: {
              anyOf: [{ type: 'null' }, { type: 'number' }],
            },
          },
          required: ['type', 'concept', 'sourcePage', 'question', 'answer', 'hint', 'source', 'options', 'correctOptionIndex'],
        },
      },
    },
    required: ['reviewQuestions'],
  } as const;

  const prompt = `
너는 시험 대비용 퀴즈만 만드는 한국어 출제 AI다.
반드시 실제 PDF 본문을 읽고, 페이지별 근거를 먼저 분석한 뒤 그 내용과 직접 연결된 문제만 만들어라.

이번 작업 목표:
- 먼저 이 PDF가 무엇을 설명하는 자료인지 파악한다.
- 그 뒤 시험에 나올 가능성이 높은 개념, 정의, 원리, 과정, 비교 포인트만 골라 문제를 만든다.
- 절대로 일반론, 상식형 문제, 자료와 무관한 추측 문제를 만들지 않는다.

반드시 지켜라:
1) 출력은 JSON만.
2) reviewQuestions는 4~5개만 만든다.
3) type은 short/ox/mcq만 사용하고 세 유형이 섞이게 한다.
4) question/answer/hint/source/options/concept는 모두 자연스러운 한국어로 작성한다.
5) question은 반드시 구체적인 개념명을 포함해야 하며, "다음 자료", "자료 문장", "PDF 본문" 같은 일반 표현만으로 묻지 마라.
6) sourcePage는 실제 근거 페이지 번호를 넣어라.
7) source는 아래 "페이지별 직접 근거" 중 하나를 바탕으로 만든 짧은 근거 문구여야 한다.
8) short는 1~2문장 핵심답, ox는 answer를 O 또는 X, mcq는 보기 4개와 correctOptionIndex 0~3을 반드시 포함한다.
9) 수식, URL, 기호를 그대로 암기시키기보다 의미/역할/해석을 묻는 문제를 우선한다.
10) PDF에서 확인되지 않는 내용은 절대 추가하지 마라.

입력:
- 과목: ${payload.subject ?? '미지정'}
- 강의 제목: ${payload.lectureTitle}
- PDF 압축 본문:
${compactedPdf}

- 페이지 개요:
${compactedPageOutline || '- 페이지 개요 없음'}

- 페이지별 직접 근거:
${quizEvidence.evidenceText || '- 근거 없음'}
`;

  try {
    const initial = await generateGeminiJson<{ reviewQuestions: GroundedQuizQuestion[] }>({
      model: GEMINI_MODELS.reasoning,
      prompt,
      schema,
    });

    const initialValidation = validateGroundedQuizQuestions(initial.reviewQuestions, quizEvidence.evidenceSources);
    if (!initialValidation.problems.length) {
      return { reviewQuestions: initialValidation.normalized };
    }

    const repaired = await generateGeminiJson<{ reviewQuestions: GroundedQuizQuestion[] }>({
      model: GEMINI_MODELS.reasoning,
      prompt: `${prompt}

이전 시도에서 아래 문제가 있었다:
- ${initialValidation.problems.join('\n- ')}

이전 JSON:
${JSON.stringify(initial)}

이번에는 반드시 위 문제를 모두 고쳐서 다시 생성하라.
특히 source는 페이지별 직접 근거와 일치해야 하고, 질문 문장에는 실제 개념명이 들어가야 한다.
`,
      schema,
    });

    const repairedValidation = validateGroundedQuizQuestions(repaired.reviewQuestions, quizEvidence.evidenceSources);
    if (!repairedValidation.problems.length) {
      return { reviewQuestions: repairedValidation.normalized };
    }

    throw new Error('AI가 PDF 근거 기반 퀴즈를 안정적으로 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  } catch (error) {
    throw new Error(toUserFacingGeminiError(error));
  }
}

export async function regeneratePageNote(payload: {
  subject?: string;
  lectureTitle: string;
  pageNumber: number;
  pageText: string;
  currentNote?: string;
  fullSummary?: string;
  examFocus?: string[];
  transcriptText?: string;
  notionText?: string;
  customNotes?: string;
}) {
  const pageTextMax = toInt(process.env.AI_GENERATE_PDF_MAX_CHARS, LOW_TOKEN_MODE ? 2200 : 5000);
  const supportingTextMax = toInt(process.env.AI_GENERATE_NOTES_MAX_CHARS, LOW_TOKEN_MODE ? 800 : 2200);

  try {
    const result = await generateGeminiJson<{ notes: string }>({
      model: LOW_TOKEN_MODE ? GEMINI_MODELS.text : GEMINI_MODELS.reasoning,
      prompt: `
너는 PDF 페이지별 필기를 다시 써주는 강의자료 필기 AI다.
목표는 ${payload.pageNumber}페이지에 들어갈 필기를 더 정확하고 시험 친화적으로 다시 만드는 것이다.

반드시 지켜라:
1) 출력은 JSON만.
2) notes는 반드시 한국어.
3) notes는 ${LOW_TOKEN_MODE ? '1~3줄' : '2~5줄'}로 간결하게 작성.
4) 반드시 아래 "페이지 본문"을 가장 우선해서 분석해라.
5) 해당 페이지에서 직접 확인되지 않는 내용을 추측해서 넣지 마라.
6) 정의, 원리, 과정, 비교, 시험 포인트 중심으로 다시 정리해라.
7) 현재 필기 초안이 있더라도 그대로 베끼지 말고 더 자연스럽고 이해하기 쉽게 다시 써라.

입력:
- 과목: ${payload.subject ?? '미지정'}
- 강의 제목: ${payload.lectureTitle}
- 페이지 번호: ${payload.pageNumber}
- 페이지 본문: ${compactContext(payload.pageText, pageTextMax)}
- 현재 필기 초안: ${compactContext(payload.currentNote ?? '', supportingTextMax)}
- 전체 요약: ${compactContext(payload.fullSummary ?? '', supportingTextMax)}
- 시험 포인트: ${compactContext((payload.examFocus ?? []).join('\n'), supportingTextMax)}
- 음성 전사: ${compactContext(payload.transcriptText ?? '', supportingTextMax)}
- 노션 메모: ${compactContext(payload.notionText ?? '', supportingTextMax)}
- 사용자 메모: ${compactContext(payload.customNotes ?? '', supportingTextMax)}
`,
      schema: {
        type: 'object',
        properties: {
          notes: { type: 'string' },
        },
        required: ['notes'],
      },
    });

    return result.notes.trim();
  } catch (error) {
    throw new Error(toUserFacingGeminiError(error));
  }
}
