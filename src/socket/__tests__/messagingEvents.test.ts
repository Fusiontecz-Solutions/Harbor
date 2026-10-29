/**
 * Event plumbing for the inbox: every emit is scoped to the rooms allowed by
 * visibleSendersForUser, and sockets only join the rooms their inbox shows.
 * No database or network — prisma, sender scoping and the io server are fakes.
 */
const emitted: Array<{ rooms: string[]; event: string; payload: any }> = [];

const fakeIo = {
  to: (rooms: string | string[]) => ({
    emit: (event: string, payload: unknown) => {
      emitted.push({ rooms: ([] as string[]).concat(rooms), event, payload });
    },
  }),
};

const conversations: Record<string, { businessNumber: string }> = {
  'conv-a': { businessNumber: '+15550001111' },
  'conv-b': { businessNumber: '+15550002222' },
};

jest.mock('../../config/prismaClient', () => ({
  __esModule: true,
  default: {
    messagingConversation: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => conversations[where.id] ?? null),
    },
  },
}));

jest.mock('../../config/redis', () => ({ getRedisClient: () => null }));

jest.mock('../../services/messaging/conversation.service', () => ({
  getTotalUnread: jest.fn(async (senders?: string[]) => (senders ? 1 : 7)),
}));

jest.mock('../../services/messaging/sender.service', () => ({
  visibleSendersForUser: jest.fn(async (userId: string) => {
    if (userId === 'admin') return null;
    if (userId === 'rep-a') return ['+15550001111'];
    if (userId === 'rep-b') return ['+15550002222'];
    return [];
  }),
}));

jest.mock('../index', () => {
  const actual = jest.requireActual('../index');
  return { ...actual, getSocketIO: () => fakeIo };
});

import {
  emitConversationUpdate,
  emitMessageStatusUpdate,
  emitNewMessage,
  emitUnreadCountUpdate,
} from '../messagingEvents';
import { canSeeConversation, syncMessagingRooms } from '../index';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeSocket(userId: string, role?: string) {
  const rooms = new Set<string>(['socket-id']);
  return {
    data: { userId, role },
    rooms,
    join: (room: string) => rooms.add(room),
    leave: (room: string) => rooms.delete(room),
  };
}

beforeEach(() => {
  emitted.length = 0;
});

describe('messaging socket scoping', () => {
  it('sends a new message only to privileged, its sender room and the thread room', async () => {
    emitNewMessage('conv-a', { id: 'm1', direction: 'INBOUND', body: 'hi' });
    await flush();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe('new_message');
    expect(emitted[0].rooms.sort()).toEqual(
      ['messaging:all', 'messaging:conv:conv-a', 'messaging:sender:+15550001111'].sort(),
    );
    expect(emitted[0].payload.conversationId).toBe('conv-a');
  });

  it('never targets another rep\'s sender room', async () => {
    emitConversationUpdate({ id: 'conv-b', unreadCount: 0 });
    emitMessageStatusUpdate('conv-b', { messageId: 'x', providerMessageId: 'x', status: 'DELIVERED' });
    await flush();

    for (const e of emitted) {
      expect(e.rooms).not.toContain('messaging:sender:+15550001111');
      expect(e.rooms).not.toContain('messaging:inbox');
    }
  });

  it('uses the supplied business number for a deleted row', async () => {
    emitConversationUpdate({ id: 'gone', deleted: true, businessNumber: '+15550002222' });
    await flush();
    expect(emitted[0].rooms).toContain('messaging:sender:+15550002222');
  });

  it('scopes unread totals per audience', async () => {
    emitUnreadCountUpdate('conv-a');
    await flush();
    await flush();
    const all = emitted.find((e) => e.rooms.includes('messaging:all'));
    const rep = emitted.find((e) => e.rooms.includes('messaging:sender:+15550001111'));
    expect(all?.payload.unreadCount).toBe(7);
    expect(rep?.payload.unreadCount).toBe(1);
    expect(all?.rooms).toHaveLength(1);
    expect(rep?.rooms).toHaveLength(1);
  });

  it('joins rooms per visibility rule and drops stale sender rooms', async () => {
    const admin = fakeSocket('admin', 'ADMIN');
    await syncMessagingRooms(admin);
    expect(admin.rooms.has('messaging:all')).toBe(true);

    const rep = fakeSocket('rep-a', 'AGENT');
    rep.rooms.add('messaging:sender:+15550002222'); // stale assignment
    await syncMessagingRooms(rep);
    expect(rep.rooms.has('messaging:sender:+15550001111')).toBe(true);
    expect(rep.rooms.has('messaging:sender:+15550002222')).toBe(false);
    expect(rep.rooms.has('messaging:all')).toBe(false);
  });

  it('refuses a thread room outside the user\'s scope', async () => {
    expect(await canSeeConversation(fakeSocket('rep-a', 'AGENT'), 'conv-a')).toBe(true);
    expect(await canSeeConversation(fakeSocket('rep-a', 'AGENT'), 'conv-b')).toBe(false);
    expect(await canSeeConversation(fakeSocket('admin', 'ADMIN'), 'conv-b')).toBe(true);
    expect(await canSeeConversation(fakeSocket('rep-a', 'AGENT'), 'missing')).toBe(false);
  });
});
