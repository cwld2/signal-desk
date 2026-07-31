export class RelayClient {
  constructor(config) {
    this.baseUrl = (config.apiBaseUrl || "").replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.temperature = config.temperature ?? 0.1;
    this.timeoutMs = 120000;
  }

  async chat(messages, model) {
    if (!this.apiKey) throw new Error("未配置中转站 API Key，请在 .env 中设置 RELAY_API_KEY");
    if (!this.baseUrl) throw new Error("未配置中转站 API 地址，请在设置页填写");
    if (!model) throw new Error("未指定模型名称");
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model, messages, temperature: this.temperature }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`中转站 API 返回 ${response.status}：${detail.slice(0, 200)}`);
    }
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("中转站 API 未返回内容");
    return content;
  }

  extractJson(text) {
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fenceMatch ? fenceMatch[1] : text;
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end < 0) throw new Error("AI 返回中未找到 JSON");
    return JSON.parse(raw.slice(start, end + 1));
  }

  async selectArticles(candidates, config) {
    const prompt = (config.selectionPrompt || "从候选文章中选出最值得学习的若干篇。") +
      `\n\n候选文章：\n` + candidates.slice(0, 20).map((item, i) =>
        `${i + 1}. ID: ${item.id}\n标题: ${item.title}\n摘要: ${(item.summary || "").slice(0, 200)}\n`
      ).join("\n") + `\n请选出最多 ${config.maxArticles || 5} 篇，只输出 JSON 格式 {"selected":[{"id":"文章ID","reason":"一句话理由"}]}`;
    const content = await this.chat([
      { role: "system", content: "你是技术内容编辑，只输出有效 JSON。" },
      { role: "user", content: prompt }
    ], config.selectionModel);
    return this.extractJson(content);
  }

  async analyzeArticle(title, body, config) {
    const prompt = (config.analysisPrompt || "请对文章进行结构化分析。") +
      `\n\n文章标题：${title}\n\n文章正文（截取）：\n${body.slice(0, config.bodyCharLimit || 25000)}\n\n` +
      `请输出 JSON：{"summary":"120-180字列表简介","keyPoints":["核心要点"],"technicalDetails":["标明【原文事实】或【AI推断】"],"learningValue":["学习价值"]}`;
    const content = await this.chat([
      { role: "system", content: "你是擅长向入门学习者解释复杂技术的中文技术编辑。保持技术准确，只输出有效 JSON。" },
      { role: "user", content: prompt }
    ], config.analysisModel);
    return this.extractJson(content);
  }

  async batchTranslateSummary(items, model) {
    if (!items.length) return [];
    const lines = items.slice(0, 20).map((item, i) =>
      (i + 1) + ". ID: " + item.id + "\n" +
      "原始标题: " + item.title + "\n" +
      "原始摘要: " + (item.summary || "").slice(0, 150)
    ).join("\n\n");
    const prompt = "请为以下文章生成中文标题和一句话简介（30-60字）。只输出有效 JSON，格式：" +
      JSON.stringify({ results: [{ id: "文章ID", zhTitle: "中文标题", zhSummary: "一句话中文简介" }] }) +
      "\n\n" + lines;
    const content = await this.chat([
      { role: "system", content: "你是中文技术翻译和摘要编辑，只输出有效 JSON。" },
      { role: "user", content: prompt }
    ], model);
    const parsed = this.extractJson(content);
    return Array.isArray(parsed.results) ? parsed.results : [];
  }
}
