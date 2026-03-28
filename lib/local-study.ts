import type { GenerationResult } from './types';

function cleanText(input: string) {
  return (input || '').replace(/\s+/g, ' ').trim();
}

function splitSentences(text: string) {
  return cleanText(text)
    .split(/(?<=[.!?])\s+|(?<=다\.|요\.|니다\.)\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
}

function scoreSentence(sentence: string) {
  const k = /핵심|중요|시험|정의|공식|개념|주의|비교|예시|결론|요약|원리|알고리즘|모델|함수|증명/i;
  const bonus = k.test(sentence) ? 50 : 0;
  return Math.min(120, sentence.length) + bonus;
}

function topSentences(text: string, count: number) {
  return splitSentences(text)
    .sort((a, b) => scoreSentence(b) - scoreSentence(a))
    .slice(0, count);
}

function wrap(text: string, maxLen: number) {
  const words = cleanText(text).split(' ');
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length <= maxLen) {
      line = next;
    } else {
      if (line) out.push(line);
      line = w;
    }
  }
  if (line) out.push(line);
  return out;
}

function inferSubject(pdfText: string, lectureTitle: string) {
  const source = `${lectureTitle} ${pdfText}`.toLowerCase();
  if (/미분|적분|행렬|확률|통계|수학|벡터/.test(source)) return '수학';
  if (/운영체제|데이터베이스|알고리즘|네트워크|코드|함수|프로그래밍/.test(source)) return '컴퓨터공학';
  if (/경제|수요|공급|시장|거시|미시/.test(source)) return '경제학';
  if (/세포|생물|화학|물리|실험/.test(source)) return '자연과학';
  return '일반 학습';
}

function makeNotesByPage(pdfText: string) {
  const candidates = topSentences(pdfText, 24);
  const pages = Math.max(1, Math.min(8, Math.ceil(candidates.length / 3)));
  const out: { page: number; notes: string }[] = [];
  for (let i = 0; i < pages; i += 1) {
    const chunk = candidates.slice(i * 3, i * 3 + 3);
    if (!chunk.length) continue;
    const joined = chunk
      .map((line, idx) => `${idx + 1}. ${line}`)
      .join('\n');
    out.push({ page: i + 1, notes: joined });
  }
  return out.length ? out : [{ page: 1, notes: '핵심 내용을 추출하지 못해 원문 요약 기준으로 필기를 생성했습니다.' }];
}

function makeExamFocus(pdfText: string, customNotes: string) {
  const merged = `${pdfText}\n${customNotes}`;
  const lines = topSentences(merged, 12);
  return lines.slice(0, 6);
}

function makeQuestions(examFocus: string[]) {
  return examFocus.slice(0, 6).map((focus) => ({
    question: `${focus}를 설명하고 실제 적용 예시를 1개 제시하세요.`,
    answer: '핵심 정의를 먼저 말하고, 왜 중요한지와 적용 상황을 연결해 설명하면 됩니다.',
    hint: '정의 → 특징 → 예시 순서로 답하면 안정적입니다.',
  }));
}

export function generateLocalStudyPack(input: {
  lectureTitle: string;
  pdfText: string;
  transcriptText?: string;
  notionText?: string;
  customNotes?: string;
}): GenerationResult {
  const mergedPdf = cleanText(input.pdfText);
  const mergedExtras = cleanText([input.transcriptText, input.notionText, input.customNotes].filter(Boolean).join('\n'));
  const subject = inferSubject(mergedPdf, input.lectureTitle);
  const examFocus = makeExamFocus(mergedPdf, mergedExtras);
  const notesByPage = makeNotesByPage(mergedPdf);
  const questions = makeQuestions(examFocus);

  const visuals: GenerationResult['visuals'] = [];
  if (subject === '수학') {
    visuals.push({
      title: '핵심 개념 비교표',
      kind: 'table',
      caption: '로컬 모드에서 자동 생성된 비교 요약',
      table: {
        columns: ['개념', '핵심 설명', '시험 포인트'],
        rows: examFocus.slice(0, 4).map((f) => {
          const lines = wrap(f, 18);
          return [lines[0] || '개념', lines.slice(1).join(' ') || f, '정의/적용/주의점'];
        }),
      },
    });
  }

  return {
    summary: `${subject} 중심의 자료를 로컬 경량 파이프라인으로 요약했습니다.`,
    examFocus,
    notesByPage,
    visuals,
    reviewQuestions: questions,
  };
}
