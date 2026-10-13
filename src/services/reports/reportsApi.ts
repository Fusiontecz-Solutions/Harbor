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
