import { createAsyncThunk } from '@reduxjs/toolkit';
import { axiosGet } from '../axios';

export interface ActivityLogContent {
  viewType: string;
  channel?: string;
  recipient?: string;
  recipientType?: string | null;
  templateName?: string | null;
  documentName?: string | null;
  category?: string;
  subject?: string | null;
  body?: string | null;
  status?: string;
  applicationId?: string | null;
  contractId?: string | null;
  description?: string;
  metadata?: Record<string, unknown>;
  attachments?: string[];
  delivery?: Record<string, unknown>;
  note?: string;
  createdAt?: string;
}

export interface ApplicationActivityLog {
  id: string;
  applicationId: string | null;
  userId: string | null;
  userName: string | null;
  userRole: string | null;
  actionType: string;
  action?: string;
  actionDescription: string;
  previousStatus?: string | null;
  currentStatus?: string | null;
  metadata?: Record<string, unknown> | null;
  category?: string;
  channel?: string | null;
  recipientName?: string | null;
  recipientType?: string | null;
  templateName?: string | null;
  subject?: string | null;
  canView?: boolean;
  createdAt: string;
}

export const getApplicationActivityLogs = createAsyncThunk(
  'applicationActivityLogs/getByApplication',
  async (
    arg: string | number | { applicationId: string | number; page?: number; pageSize?: number },
    { rejectWithValue },
  ) => {
    try {
      // A bare id returns the whole history; page/pageSize asks the API for
      // one newest-first slice plus `pagination` (total, hasMore).
      const { applicationId, page, pageSize } =
        typeof arg === 'object' ? arg : { applicationId: arg, page: undefined, pageSize: undefined };
      const params: Record<string, number> = {};
      if (page) params.page = page;
      if (pageSize) params.pageSize = pageSize;
      const response = await axiosGet(`/applications/${applicationId}/activity-logs`, { params });
      return response.data;
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } } };
      console.error('Get application activity logs error:', error);
      return rejectWithValue(
        err.response?.data?.message || 'Failed to fetch application activity logs'
      );
    }
  }
);

export const getApplicationActivityLogContent = createAsyncThunk(
  'applicationActivityLogs/getContent',
  async (
    { applicationId, logId }: { applicationId: string; logId: string },
    { rejectWithValue },
  ) => {
    try {
      const response = await axiosGet(
        `/applications/${applicationId}/activity-logs/${logId}/content`,
      );
      return (response.data?.data ?? response.data) as ActivityLogContent;
    } catch (error: unknown) {
      const err = error as { response?: { data?: { message?: string } } };
      return rejectWithValue(
        err.response?.data?.message || 'Failed to load message content',
      );
    }
  }
);
