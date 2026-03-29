import { prisma } from '@/lib/prisma';
import { WorkspaceShell } from './components/workspace-shell';

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<{ projectId?: string }>;
}) {
  const resolvedParams = (await searchParams) || {};

  const projects = await prisma.project.findMany({
    orderBy: [{ sortOrder: 'asc' }, { updatedAt: 'desc' }],
    include: {
      assets: true,
      runs: { orderBy: { createdAt: 'desc' }, take: 1, include: { outputAsset: true } },
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });

  const selected =
    projects.find((project) => project.id === resolvedParams.projectId) ||
    projects[0] ||
    null;

  return (
    <main className="appMain">
      <WorkspaceShell
        projects={projects.map((project) => ({
          id: project.id,
          title: project.title,
          subject: project.subject,
          assetCount: project.assets.length,
          hasOutput: Boolean(project.runs[0]?.outputAsset?.publicUrl),
        }))}
        selectedProject={
          selected
            ? {
                ...(() => {
                  const latestPdf = [...selected.assets]
                    .filter((asset) => asset.kind === 'pdf')
                    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
                  return {
                    latestPdfExcerpt: (latestPdf?.extractedText || '').slice(0, 4000),
                  };
                })(),
                id: selected.id,
                title: selected.title,
                subject: selected.subject,
                description: selected.description,
                messages: selected.messages.map((message) => ({
                  id: message.id,
                  role: message.role,
                  text: message.text,
                  createdAt: message.createdAt.toISOString(),
                })),
                assets: [...selected.assets]
                  .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
                  .map((asset) => ({
                  id: asset.id,
                  kind: asset.kind,
                  originalName: asset.originalName,
                  publicUrl: asset.publicUrl,
                  createdAt: asset.createdAt.toISOString(),
                })),
                lastRun: selected.runs[0]
                  ? {
                      summary: selected.runs[0].summary,
                      outputUrl: selected.runs[0].outputAsset?.publicUrl,
                      examFocusJson: selected.runs[0].examFocusJson,
                      notesByPageJson: selected.runs[0].notesByPageJson,
                      visualsJson: selected.runs[0].visualsJson,
                      questionsJson: selected.runs[0].questionsJson,
                      createdAt: selected.runs[0].createdAt.toISOString(),
                    }
                  : null,
              }
            : null
        }
      />
    </main>
  );
}
