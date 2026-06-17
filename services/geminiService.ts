import apiClient from './apiClient';

const getAI = () => {
  return {
    models: {
      generateContent: async (config: any) => {
        return { text: "AI 功能暂未配置，请设置 VITE_GEMINI_API_KEY 环境变量" };
      }
    },
    chats: {
      create: (config: any) => ({
        sendMessage: async (msg: any) => ({ text: "AI 功能暂未配置" })
      })
    }
  };
};

export const polishContent = async (title: string, body: string) => {
  try {
    const response = await apiClient.polishContent({
      text: body,
      instruction: `请在保留原意的前提下润色正文。标题供参考：${title}`,
      type: 'body',
    });
    return response.polished_text || body;
  } catch (error) {
    console.error("Polish content error:", error);
    return null;
  }
};

export const chatWithAI = async (message: string, context: any) => {
  const ai = getAI();
  try {
    const chat = ai.chats.create({
      model: 'gemini-2.0-flash-exp',
      config: {
        systemInstruction: "你是一个AI创作助手，名叫'AI 创作工坊助手'。你协助用户进行图片调整和文案创作。",
      }
    });
    const response = await chat.sendMessage({ message });
    return response.text;
  } catch (error) {
    console.error("Gemini chat error:", error);
    return "抱歉，我现在遇到了一些问题。";
  }
};
