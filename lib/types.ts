export type Point = { x: number; y: number; label?: string };

export type VisualSpec = {
  title: string;
  kind: 'graph' | 'timeline' | 'table' | 'flowchart';
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
};

export type NotesByPage = { page: number; notes: string }[];

export type GenerationResult = {
  summary: string;
  examFocus: string[];
  notesByPage: NotesByPage;
  visuals: VisualSpec[];
  reviewQuestions: string[];
};
