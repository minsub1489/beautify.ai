import { prisma } from './prisma';

type ProjectIdRow = {
  id: string;
};

type SortOrderRow = {
  sortOrder: number | null;
};

export async function getOrderedProjectIds() {
  try {
    const rows = await prisma.$queryRaw<ProjectIdRow[]>`
      SELECT "id"
      FROM "Project"
      ORDER BY "sortOrder" ASC, "updatedAt" DESC
    `;
    return rows.map((row) => row.id);
  } catch (error) {
    console.warn('project sort order query failed, falling back to updatedAt ordering', error);
    return [];
  }
}

export async function getNextProjectSortOrder() {
  try {
    const rows = await prisma.$queryRaw<SortOrderRow[]>`
      SELECT MAX("sortOrder")::int AS "sortOrder"
      FROM "Project"
    `;
    return (rows[0]?.sortOrder ?? -1) + 1;
  } catch (error) {
    console.warn('next project sort order query failed, falling back to project count', error);
    const count = await prisma.project.count().catch(() => 0);
    return count;
  }
}

export async function assignProjectSortOrder(projectId: string, sortOrder: number) {
  try {
    await prisma.$executeRaw`
      UPDATE "Project"
      SET "sortOrder" = ${sortOrder}
      WHERE "id" = ${projectId}
    `;
    return true;
  } catch (error) {
    console.warn('project sort order update failed after create', { projectId, sortOrder, error });
    return false;
  }
}

export async function persistProjectSortOrder(projectIds: string[]) {
  try {
    await prisma.$transaction(async (tx) => {
      for (const [index, projectId] of projectIds.entries()) {
        await tx.$executeRaw`
          UPDATE "Project"
          SET "sortOrder" = ${index}
          WHERE "id" = ${projectId}
        `;
      }
    });
    return true;
  } catch (error) {
    console.warn('project sort order persist failed', error);
    return false;
  }
}
