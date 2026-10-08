import { ArchiveError } from './competitor-store.mjs';

const systemPrompt = `你是竞品档案资料整理助手。用简洁的中文回答。
用户只提供楼盘名称时，先确认城市、区域或同名项目，不要猜测具体项目。
本次对话没有联网检索、图片下载或文件读取工具。只能根据用户在对话中提供的资料整理，不能声称搜索了网页、读取了本地档案或已保存文件。不要凭记忆生成楼盘指标、价格、日期、图片网址和来源链接。
整理竞品时按项目概况、规划指标、产品与户型、价格及日期、总规划、效果图、户型图、公开航拍、来源与待核实事项组织。缺失项写“待补充”，冲突信息并列记录，分析和事实分开。保留至少三个户型位置，缺失时明确待补充。
网络信息不得冒充实地踩盘记录。你只提供整理建议和草稿，不能直接创建或修改档案。`;

export function createAIClient(getCredentials, { fetchImpl = fetch } = {}) {
  async function request(endpoint, body, signal) {
    const { baseUrl, token } = await getCredentials();
    if (!baseUrl || !token) throw new ArchiveError('请先在设置中填写 BASE_URL 和 TOKEN', 409);
    const options = {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
      ...(body ? { body: JSON.stringify(body) } : {})
    };
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/${endpoint}`, options);
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw new ArchiveError('AI 接口拒绝访问，请检查 TOKEN 和模型权限', 502);
        if (response.status === 429) throw new ArchiveError('AI 接口额度不足或请求过于频繁，请稍后再试', 502);
        if (response.status === 404) throw new ArchiveError('AI 接口路径不存在，请检查 BASE_URL 是否包含服务要求的路径', 502);
        if (response.status === 400) throw new ArchiveError('AI 接口不接受本次请求，请检查模型名称及接口是否支持对话', 502);
        throw new ArchiveError('AI 接口暂时不可用，请稍后重试', 502);
      }
      const reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) { await reader.cancel(); throw new ArchiveError('AI 回复过长，请缩小问题范围后重试', 502); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof ArchiveError) throw error;
      if (signal?.aborted) throw new ArchiveError('已停止本次对话', 499);
      if (options.signal.aborted) throw new ArchiveError('AI 回复超时，请稍后重试', 504);
      // Provider errors may contain the URL or token. Return only our own messages.
      throw new ArchiveError('无法连接 AI 接口，或回复格式不兼容，请检查设置', 502);
    }
  }

  return {
    async models(signal) {
      const result = await request('models', null, signal);
      if (!Array.isArray(result.data)) throw new ArchiveError('接口无法读取模型列表，可在对话窗口直接填写模型名称', 502);
      const models = [...new Set(result.data.map(item => item?.id).filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\x00-\x1f\x7f]/.test(id)))].slice(0, 200);
      if (!models.length) throw new ArchiveError('接口未提供可用模型，请检查模型权限', 502);
      return models;
    },
    async chat(input, signal) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ArchiveError('对话格式不正确');
      const model = typeof input.model === 'string' ? input.model.trim() : '';
      if (!model || model.length > 200 || /[\x00-\x1f\x7f]/.test(model)) throw new ArchiveError('请选择或填写模型名称');
      if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 20) throw new ArchiveError('对话过长，请开启新对话');
      let total = 0;
      const messages = input.messages.map(message => {
        if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 12000) throw new ArchiveError('对话内容格式不正确');
        total += message.content.length;
        return { role: message.role, content: message.content };
      });
      if (total > 60000 || messages.at(-1).role !== 'user') throw new ArchiveError('对话过长或内容不正确，请开启新对话');
      const result = await request('chat/completions', { model, messages: [{ role: 'system', content: systemPrompt }, ...messages], stream: false }, signal);
      const content = result.choices?.[0]?.message?.content;
      const reply = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text || '').join('\n') : '';
      if (!reply.trim()) throw new ArchiveError('AI 没有返回文字，请换一个支持对话的模型', 502);
      if (reply.length > 12000) throw new ArchiveError('AI 回复过长，请要求更简短的回复', 502);
      return { reply, model };
    }
  };
}
