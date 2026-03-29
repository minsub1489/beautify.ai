import { GEMINI_MODELS, generateGeminiJson, toUserFacingGeminiError } from './openai';
import type { GenerationResult } from './types';

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
}): Promise<GenerationResult> {
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
18) reviewQuestions는 ${LOW_TOKEN_MODE ? '4개' : '4~5개'}만 만들고, 반드시 PDF 본문과 페이지 개요만 분석해서 출제해라.
19) reviewQuestions의 type은 short/ox/mcq만 사용하고, 세 유형이 고르게 섞이게 만들어라.
20) short: answer는 1~2문장 핵심답. ox: answer는 반드시 O 또는 X 중 하나. mcq: options는 반드시 4개, correctOptionIndex는 0~3.
21) 모든 quiz question/answer/hint/options/source는 반드시 한국어로 작성해라.
22) 각 문제마다 source에 PDF 본문 또는 페이지 개요에서 실제로 확인되는 출제 근거 문구(짧은 발췌)를 넣어라.
23) transcript/notion/customNotes는 notesByPage 보조용일 뿐, reviewQuestions의 근거로 사용하면 안 된다.
24) source와 무관한 일반론/상식형 문제는 금지한다.
25) PDF에서 중요도가 낮은 주변 설명은 문제화하지 말고, 정의/원리/과정/비교/결론처럼 시험에 바로 나올 핵심만 고른다.
26) hint는 한 줄 힌트로 작성하고, 답을 그대로 반복하지 말아라.
27) formula를 만들 때 expression은 가능한 한 짧고 읽기 쉬운 식/의사수식으로 적고, meaning/example은 학생이 이해하기 쉬운 한국어로 적는다.

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
reviewQuestions: [{type:'short'|'ox'|'mcq', question:string, answer:string, hint?:string, source:string, options?:string[], correctOptionIndex?:number}]
`;

  try {
    return await generateGeminiJson<GenerationResult>({
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
          },
          reviewQuestions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['short', 'ox', 'mcq'] },
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
              required: ['type', 'question', 'answer', 'hint', 'source', 'options', 'correctOptionIndex'],
            },
          }
        },
        required: ['summary', 'examFocus', 'notesByPage', 'visuals', 'reviewQuestions']
      },
    });
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
