import { Client } from '@notionhq/client';

export function getNotionClient() {
  const auth = process.env.NOTION_TOKEN;
  if (!auth) throw new Error('NOTION_TOKEN이 없습니다.');
  return new Client({ auth });
}

export async function readNotionPageBlocks(pageId: string) {
  const notion = getNotionClient();
  const response = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });
  return response.results
    .map((block: any) => {
      const type = block.type;
      const richText = block[type]?.rich_text ?? [];
      return richText.map((t: any) => t.plain_text).join('');
    })
    .filter(Boolean)
    .join('\n');
}
