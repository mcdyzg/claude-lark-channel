export interface LarkAttachment {
  fileKey: string;
  fileName: string;
  fileType: 'image' | 'file' | 'audio' | 'video';
}

export interface LarkMention {
  id: string;
  name: string;
}

export interface LarkMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group' | string;
  senderId: string;
  senderName?: string;
  chatName?: string;
  text: string;
  messageType: string;
  parentId?: string;
  parentContent?: string;
  threadId?: string;
  mentions: LarkMention[];
  attachments: LarkAttachment[];
  rawContent: string;
  imagePath?: string;
  imagePaths?: string[];
}
