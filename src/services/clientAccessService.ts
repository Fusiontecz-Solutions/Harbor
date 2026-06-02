import type { Prisma } from '@prisma/client';
import prisma from '../config/prismaClient';
import type { AuthenticatedUser } from './applicationService';

function normalizeRole(role: string | null | undefined): string | null {
    if (!role) return null;
    const key = String(role).trim().toUpperCase().replace(/-/g, '_');
    return key || null;
}

/** Clients an agent may see: created/assigned to them or tied to their applications. */
export function buildAgentClientVisibilityWhere(
    userId: string,
): Prisma.ClientWhereInput {
    return {
        OR: [
            { createdById: userId },
            { assignedToId: userId },
            {
                applications: {
                    some: {
                        OR: [{ referringAgentId: userId }, { createdById: userId }],
                    },
                },
            },
        ],
    };
}

export function mergeClientVisibilityWhere(
    base: Prisma.ClientWhereInput,
    user: AuthenticatedUser | null | undefined,
): Prisma.ClientWhereInput {
    if (!user?.id || normalizeRole(user.role) !== 'AGENT') {
        return base;
    }

    const agentFilter = buildAgentClientVisibilityWhere(user.id);
    const existingAnd = base.AND
        ? Array.isArray(base.AND)
            ? base.AND
            : [base.AND]
        : [];

    return {
        ...base,
        AND: [...existingAnd, agentFilter],
    };
}

export async function agentCanAccessClient(
    clientId: string,
    userId: string,
): Promise<boolean> {
    const count = await prisma.client.count({
        where: {
            AND: [{ id: clientId }, buildAgentClientVisibilityWhere(userId)],
        },
    });
    return count > 0;
}
