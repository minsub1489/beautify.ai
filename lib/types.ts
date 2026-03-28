export type Point = { x: number; y: number; label?: string };

export type VisualSpec = {
  title: string;
  page?: number;
  kind: 'graph' | 'timeline' | 'table' | 'flowchart' | 'formula';
  caption: string;
  graph?: {
    xLabel: string;
    yLabel: string;
    series: { label: string; points: Point[] }[];
  };
  timeline?: {
    events: { year: string; label: string; detail?: string }[];
  };
  table?: {
    columns: string[];
    rows: string[][];
  };
  flowchart?: {
    nodes: { id: string; label: string }[];
    edges: { from: string; to: string; label?: string }[];
  };
  formula?: {
    expression: string;
    meaning?: string;
    example?: string;
  };
};

export type NotesByPage = { page: number; notes: string }[];

export type QuizQuestion = {
  type?: 'short' | 'ox' | 'mcq';
  question: string;
  answer: string;
  hint?: string;
  source?: string;
  options?: string[];
  correctOptionIndex?: number;
};

export type GenerationResult = {
  summary: string;
  examFocus: string[];
  notesByPage: NotesByPage;
  visuals: VisualSpec[];
  reviewQuestions: QuizQuestion[];
};
