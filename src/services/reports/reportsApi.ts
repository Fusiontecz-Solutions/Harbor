import { axiosGet } from '@/redux/axios';

export const REPORT_SECTIONS = [
    { id: 'broadcasts', label: 'Broadcasts', hint: 'Every campaign, every recipient, and every reply with its text' },
    { id: 'inbox', label: 'Inbox', hint: 'Conversations and every message sent or received' },
    { id: 'agents', label: 'Agent / lead performance', hint: 'Leads, dispositions, sends, replies and opt-outs per user' },
    { id: 'applications', label: 'Applications', hint: 'Deals created in the period with offer and status details' },
] as const;

export type ReportSectionId = (typeof REPORT_SECTIONS)[number]['id'];

export interface ReportSummary {
    range: { from: string; to: string };
    broadcasts: {
        campaigns: number;
        recipients: number;
        sent: number;
        delivered: number;
        failed: number;
        suppressed: number;
        replied: number;
        optedOut: number;
        deliveryRate: number | null;
        replyRate: number | null;
    };
    inbox: { activeConversations: number; messagesSent: number; messagesReceived: number; optOuts: number };
    leads: { imported: number };
    applications: { total: number; byQueue: Array<{ queue: string; count: number }> };
}

export async function fetchReportSummary(params: { from: string; to: string }): Promise<ReportSummary> {
    const response = await axiosGet('/reports/summary', { params });
    return response.data.data;
}

export type ReportFormat = 'xlsx' | 'pdf';

/** Downloads the report. Large ranges can take a little while to build. */
export async function downloadReport(params: {
    from: string;
    to: string;
    sections: ReportSectionId[];
    format: ReportFormat;
}): Promise<void> {
    const response = await axiosGet('/reports/export', {
        params: { from: params.from, to: params.to, sections: params.sections.join(','), format: params.format },
        responseType: 'blob',
        timeout: 300_000,
    });

    const disposition = String(response.headers?.['content-disposition'] ?? '');
    const filename =
        /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? `harbor-report-${params.from}-to-${params.to}.${params.format}`;

    const url = URL.createObjectURL(
        new Blob([response.data], {
            type:
                params.format === 'pdf'
                    ? 'application/pdf'
                    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

export interface DashboardKpis {
    campaigns: number;
    recipients: number;
    sent: number;
    delivered: number;
    failed: number;
    replies: number;
    repliers: number;
    optOuts: number;
    directSent: number;
    leadsImported: number;
    applications: number;
    spend: number;
}

export interface ReportDashboard {
    range: { from: string; to: string };
    previousRange: { from: string; to: string };
    kpis: DashboardKpis;
    previous: DashboardKpis;
    rates: {
        delivery: number | null;
        reply: number | null;
        optOut: number | null;
        failure: number | null;
        previousDelivery: number | null;
        previousReply: number | null;
        previousOptOut: number | null;
    };
    spend: { total: number; currency: string | null; perDelivered: number | null; perReplier: number | null };
    daily: Array<{ day: string; sent: number; delivered: number; failed: number; replies: number; optOuts: number; applications: number }>;
    campaigns: Array<{
        id: string;
        name: string;
        status: string;
        createdAt: string;
        createdBy: string | null;
        recipients: number;
        sent: number;
        delivered: number;
        failed: number;
        suppressed: number;
        replied: number;
        optOuts: number;
        deliveryRate: number | null;
        replyRate: number | null;
        optOutRate: number | null;
        cost: number | null;
        segments: number | null;
        durationMinutes: number | null;
    }>;
    agents: Array<{
        name: string;
        role: string;
        leadsOwned: number;
        interested: number;
        notInterested: number;
        broadcasts: number;
        broadcastSent: number;
        directSent: number;
        replies: number;
        replyRate: number | null;
        optOuts: number;
        conversations: number;
    }>;
    leads: {
        total: number;
        importedInPeriod: number;
        batchesInPeriod: number;
        new: number;
        interested: number;
        notInterested: number;
        blocked: number;
        optedOut: number;
    };
    applications: { total: number; requestedAmount: number; byQueue: Array<{ queue: string; count: number; requested: number }> };
}

export async function fetchReportDashboard(params: { from: string; to: string }): Promise<ReportDashboard> {
    const response = await axiosGet('/reports/dashboard', { params });
    return response.data.data;
}
