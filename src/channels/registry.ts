import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  OnObservedMessage,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  /**
   * Optional audit-log hook. Channels whose connection already sees every
   * chat the user participates in (e.g. WhatsApp on the user's own account)
   * forward messages here so `all_messages` covers unregistered chats.
   * Other channels use a separate observer daemon instead.
   */
  onObservedMessage?: OnObservedMessage;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
