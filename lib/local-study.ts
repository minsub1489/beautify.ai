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

function makeNotesByPage(pdfText: string, pdfPageTexts?: string[]) {
  if (pdfPageTexts?.length) {
    const pageNotes = pdfPageTexts
      .map((pageText, index) => {
        const lines = topSentences(pageText, 3);
        if (!lines.length) return null;
        return {
          page: index + 1,
          notes: lines
            .slice(0, 3)
            .map((line, lineIndex) => `${lineIndex + 1}. ${cleanText(line)}`)
            .join('\n'),
        };
      })
      .filter((item): item is { page: number; notes: string } => Boolean(item));

    if (pageNotes.length) return pageNotes;
  }

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

function makeQuizFocus(pdfText: string, pdfPageTexts?: string[]) {
  const fromPages = (pdfPageTexts ?? [])
    .flatMap((pageText) => topSentences(pageText, 2))
    .map((line) => cleanText(line))
    .filter(Boolean);

  const base = (fromPages.length ? fromPages : topSentences(pdfText, 10))
    .map((line) => cleanText(line))
    .filter(Boolean);

  return base.slice(0, 5);
}

function makeQuestions(quizFocus: string[]) {
  const base = quizFocus.slice(0, 5);
  const snippets = base.map((line) => cleanText(line).slice(0, 90));
  return base.map((focus, idx) => {
    const source = snippets[idx] || cleanText(focus).slice(0, 90);

    if (idx % 3 === 0) {
      return {
        type: 'short' as const,
        question: `다음 자료 내용을 바탕으로 핵심 개념을 한국어로 설명하세요: "${source}"`,
        answer: '자료 문장에서 말하는 핵심 개념의 정의와 의미를 1~2문장으로 정리하면 됩니다.',
        hint: '문장 속 핵심 용어를 먼저 찾고, 그 용어의 역할을 설명하세요.',
        source,
      };
    }

    if (idx % 3 === 1) {
      return {
        type: 'ox' as const,
        question: `다음 진술이 자료 내용과 일치하면 O, 아니면 X를 고르세요: "${source}"`,
        answer: 'O',
        hint: '원문에서 같은 표현 또는 같은 의미가 있는지 확인해 보세요.',
        source,
      };
    }

    const distractorA = snippets[(idx + 1) % Math.max(1, snippets.length)] || '주요 개념과 직접 관련 없는 설명';
    const distractorB = snippets[(idx + 2) % Math.max(1, snippets.length)] || '자료 범위를 벗어난 일반 상식 설명';

    return {
      type: 'mcq' as const,
      question: `다음 자료 문장과 가장 잘 맞는 해석을 고르세요: "${source}"`,
      options: [
        '자료 문장의 핵심 개념/원리를 정확히 설명한 해석',
        `자료와 직접 관련 없는 진술: ${distractorA}`,
        `자료의 핵심을 벗어난 진술: ${distractorB}`,
        '근거 없이 결론만 단정한 해석',
      ],
      correctOptionIndex: 0,
      answer: '자료 문장의 핵심 개념/원리를 정확히 설명한 해석',
      hint: '자료 문장에서 무엇을 설명하는지(정의/원리/과정)부터 구분하세요.',
      source,
    };
  });
}

export function generateLocalStudyPack(input: {
  lectureTitle: string;
  pdfText: string;
  pdfPageTexts?: string[];
  transcriptText?: string;
  notionText?: string;
  customNotes?: string;
}): GenerationResult {
  const mergedPdf = cleanText(input.pdfText);
  const mergedExtras = cleanText([input.transcriptText, input.notionText, input.customNotes].filter(Boolean).join('\n'));
  const subject = inferSubject(mergedPdf, input.lectureTitle);
  const examFocus = makeExamFocus(mergedPdf, mergedExtras);
  const notesByPage = makeNotesByPage(mergedPdf, input.pdfPageTexts);
  const quizFocus = makeQuizFocus(mergedPdf, input.pdfPageTexts);
  const questions = makeQuestions(quizFocus.length ? quizFocus : examFocus);

  const visuals: GenerationResult['visuals'] = [];
  if (subject === '수학') {
    visuals.push({
      title: '핵심 수식 카드',
      page: notesByPage[0]?.page || 1,
      kind: 'formula',
      caption: '핵심 개념을 식으로 짧게 정리한 카드',
      formula: {
        expression: 'output = input x weight + bias',
        meaning: examFocus[0] || '핵심 관계를 식으로 요약했습니다.',
        example: examFocus[1] || '각 항이 어떤 의미인지 함께 복습하세요.',
      },
    });
  } else if (subject === '컴퓨터공학') {
    visuals.push({
      title: '처리 흐름 카드',
      page: notesByPage[0]?.page || 1,
      kind: 'flowchart',
      caption: '로컬 모드에서 만든 간단한 처리 흐름',
      flowchart: {
        nodes: [
          { id: 'n1', label: '입력 확인' },
          { id: 'n2', label: '핵심 처리' },
          { id: 'n3', label: '출력/결과' },
        ],
        edges: [
          { from: 'n1', to: 'n2', label: '다음 단계' },
          { from: 'n2', to: 'n3', label: '결과 도출' },
        ],
      },
    });
  } else if (examFocus.length >= 2) {
    visuals.push({
      title: '핵심 비교 카드',
      page: notesByPage[Math.min(1, notesByPage.length - 1)]?.page || 1,
      kind: 'table',
      caption: '시험 포인트를 빠르게 비교하는 표',
      table: {
        columns: ['항목', '핵심 설명'],
        rows: examFocus.slice(0, 3).map((focus) => {
          const lines = wrap(focus, 20);
          return [lines[0] || '핵심', lines.slice(1).join(' ') || focus];
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

export function regenerateLocalPageNote(input: {
  pageText: string;
  currentNote?: string;
}) {
  const candidates = topSentences(`${input.pageText}\n${input.currentNote ?? ''}`, 4);
  if (!candidates.length) {
    return cleanText(input.currentNote || '이 페이지의 핵심 내용을 다시 정리했습니다.');
  }

  return candidates
    .slice(0, 3)
    .map((line, idx) => `${idx + 1}. ${cleanText(line)}`)
    .join('\n');
}
