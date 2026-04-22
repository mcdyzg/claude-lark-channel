export function passesWhitelist(
  senderId: string,
  chatId: string,
  allowedUserIds: string[],
  allowedChatIds: string[],
): boolean {
  const userConfigured = allowedUserIds.length > 0;
  const chatConfigured = allowedChatIds.length > 0;
  if (!userConfigured && !chatConfigured) return true;
  const userOk = userConfigured && allowedUserIds.includes(senderId);
  const chatOk = chatConfigured && allowedChatIds.includes(chatId);
  return userOk || chatOk;
}
