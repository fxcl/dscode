export interface ArXivResult {
  id: string;
  title: string;
  summary: string;
  authors: string[];
  published: string;
  pdfUrl: string;
}

export interface HuggingFaceModelResult {
  id: string;
  downloads: number;
  likes: number;
  pipeline_tag: string;
}

export async function searchArXiv(query: string, limit: number = 10): Promise<ArXivResult[]> {
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch from arXiv API: ${response.statusText}`);
  }
  const text = await response.text();

  const entries: ArXivResult[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  
  while ((match = entryRegex.exec(text)) !== null) {
    const entryData = match[1] ?? "";
    
    const idMatch = entryData.match(/<id>(.*?)<\/id>/);
    const titleMatch = entryData.match(/<title>([\s\S]*?)<\/title>/);
    const summaryMatch = entryData.match(/<summary>([\s\S]*?)<\/summary>/);
    const publishedMatch = entryData.match(/<published>(.*?)<\/published>/);
    
    const id = idMatch && idMatch[1] ? idMatch[1].trim() : "";
    const title = titleMatch && titleMatch[1] ? titleMatch[1].replace(/\s+/g, ' ').trim() : "";
    const summary = summaryMatch && summaryMatch[1] ? summaryMatch[1].replace(/\s+/g, ' ').trim() : "";
    const published = publishedMatch && publishedMatch[1] ? publishedMatch[1].trim() : "";
    
    let pdfUrl = "";
    const linkRegex = /<link[^>]*href="(.*?)"[^>]*title="pdf"[^>]*>/;
    const linkMatch = linkRegex.exec(entryData);
    if (linkMatch && linkMatch[1]) {
      pdfUrl = linkMatch[1];
    } else {
      pdfUrl = id.replace('/abs/', '/pdf/');
    }

    const authors: string[] = [];
    const authorRegex = /<author>[\s\S]*?<name>(.*?)<\/name>[\s\S]*?<\/author>/g;
    let authorMatch;
    while ((authorMatch = authorRegex.exec(entryData)) !== null) {
      if (authorMatch[1]) authors.push(authorMatch[1].trim());
    }

    entries.push({
      id,
      title,
      summary,
      authors,
      published,
      pdfUrl
    });
  }

  return entries;
}

export async function searchHuggingFaceModels(query: string, limit: number = 10): Promise<HuggingFaceModelResult[]> {
  const url = `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&limit=${limit}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch from HuggingFace API: ${response.statusText}`);
  }
  const data = await response.json() as any[];

  return data.map(item => ({
    id: item.modelId || item.id || "",
    downloads: item.downloads || 0,
    likes: item.likes || 0,
    pipeline_tag: item.pipeline_tag || ""
  }));
}
