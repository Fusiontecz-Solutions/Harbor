import axios from 'axios';
import type { AxiosInstance, AxiosRequestConfig, InternalAxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import {
    clearHttpGetCache,
    clearInFlightGet,
    getInFlightGet,
    httpGetCacheKey,
    readCachedGetResponse,
    setInFlightGet,
    shouldUseGetResponseCache,
    toCachedAxiosResponse,
    writeCachedGetResponse,
} from '@/lib/httpGetCache';
import { clearImpersonationState } from '@/lib/impersonation';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000/api/v1';

/** Default request budget — many CRM list/aggregate endpoints exceed 25s under load. */
const DEFAULT_AXIOS_TIMEOUT_MS = 120_000;

const axiosInstance: AxiosInstance = axios.create({
    baseURL: API_BASE_URL,
    timeout: DEFAULT_AXIOS_TIMEOUT_MS,
    headers: {
        'Content-Type': 'application/json',
    },
});

// axiosInstance.interceptors.request.use(
//     (config: InternalAxiosRequestConfig) => {
//         const token = localStorage.getItem('token')?.toString() || sessionStorage.getItem('token')?.toString();

//         if (token && config.headers) {
//             config.headers.Authorization = `Bearer ${token}`;
//         }

//         return config;
//     },
//     (error: AxiosError) => {
//         return Promise.reject(error);
//     }
// );

axiosInstance.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
  
      const token =
        localStorage.getItem("token")?.toString() ||
        sessionStorage.getItem("token")?.toString();
  
      // 🔥 Don't overwrite existing Authorization header
      if (token && config.headers && !config.headers.Authorization) {
        config.headers.Authorization = `Bearer ${token}`;
      }
  
        // Let the browser set Content-Type for FormData (multipart/form-data + boundary)
        if (config.data instanceof FormData && config.headers) {
            delete config.headers['Content-Type'];
        }

      return config;
    },
    (error: AxiosError) => Promise.reject(error)
  );

/**
 * The backend builds DocuSign handoff links (`…/docusign/open-sender-view/<token>`) from the
 * request's Host + path. Behind a reverse proxy that strips a path prefix (e.g. `/backend`)
 * that link loses the prefix and lands on the SPA instead of the API. Re-anchor every such
 * link onto the API base URL this client actually talks to.
 */
const SENDER_VIEW_HANDOFF_RE = /^https?:\/\/[^\s]*?\/docusign\/open-sender-view\/([^/?#\s]+)/i;

function resolvedApiBaseUrl(): string {
    const base = API_BASE_URL.replace(/\/+$/, '');
    if (/^https?:\/\//i.test(base)) return base;
    return typeof window !== 'undefined' ? `${window.location.origin}${base.startsWith('/') ? '' : '/'}${base}` : base;
}

function rewriteSenderViewHandoffUrls(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') {
        const match = SENDER_VIEW_HANDOFF_RE.exec(value);
        return match ? `${resolvedApiBaseUrl()}/docusign/open-sender-view/${match[1]}` : value;
    }
    if (depth > 4 || !value || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
        value.forEach((item, i) => {
            value[i] = rewriteSenderViewHandoffUrls(item, depth + 1);
        });
        return value;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        record[key] = rewriteSenderViewHandoffUrls(record[key], depth + 1);
    }
    return record;
}

axiosInstance.interceptors.response.use(
    (response: AxiosResponse) => {
        if ((response.config?.url ?? '').includes('docusign') && response.data) {
            response.data = rewriteSenderViewHandoffUrls(response.data);
        }
        return response;
    },
    (error: AxiosError) => {
        if (error.response) {
            const { status } = error.response;
            const requestUrl = error.config?.url ?? '';
            const isLoginRequest = requestUrl.includes('/auth/login');

            const isDocusignIntegrationRequest = requestUrl.includes('/docusign/');
            const isPublicPortalRequest = requestUrl.includes('/public/application/');

            if (
                status === 401 &&
                !isLoginRequest &&
                !isDocusignIntegrationRequest &&
                !isPublicPortalRequest
            ) {
                localStorage.removeItem('token');
                sessionStorage.removeItem('token');
                clearImpersonationState();
                if (window.location.pathname !== '/login') {
                    window.location.href = '/login';
                }
            }

            if (status === 403) {
                console.error('Access forbidden');
            }

            if (status === 500) {
                console.error('Internal server error');
            }
        }

        return Promise.reject(error);
    }
);

function cachedGet(url: string, config?: AxiosRequestConfig) {
    const key = httpGetCacheKey(url, config);
    const inflight = getInFlightGet(key);
    if (inflight) return inflight;

    if (shouldUseGetResponseCache(url, config)) {
        const cached = readCachedGetResponse(key);
        if (cached) {
            return Promise.resolve(toCachedAxiosResponse(cached, config));
        }
    }

    const request = axiosInstance.get(url, config).then((response) => {
        if (shouldUseGetResponseCache(url, config)) {
            writeCachedGetResponse(key, response);
        }
        return response;
    });
    setInFlightGet(key, request);
    void request.finally(() => clearInFlightGet(key));
    return request;
}

function afterSuccessfulMutation<T>(promise: Promise<T>): Promise<T> {
    return promise.then((result) => {
        clearHttpGetCache();
        return result;
    });
}

export const axiosGet = (url: string, config?: AxiosRequestConfig) =>
    cachedGet(url, config);
export const axiosPost = (url: string, payload?: any, config?: AxiosRequestConfig) =>
    afterSuccessfulMutation(axiosInstance.post(url, payload, config));
export const axiosPut = (url: string, payload?: any, config?: AxiosRequestConfig) =>
    afterSuccessfulMutation(axiosInstance.put(url, payload, config));
export const axiosPatch = (url: string, payload?: any, config?: AxiosRequestConfig) =>
    afterSuccessfulMutation(axiosInstance.patch(url, payload, config));
export const axiosDelete = (url: string, config?: AxiosRequestConfig) =>
    afterSuccessfulMutation(axiosInstance.delete(url, config));

// FormData upload helper – interceptor clears Content-Type so browser sets multipart/form-data + boundary
export const axiosPostFormData = (
    url: string,
    formData: FormData,
    config?: AxiosRequestConfig
) =>
    afterSuccessfulMutation(
        axiosInstance.post(url, formData, { timeout: 120000, ...config }),
    );

export const axiosPatchFormData = (
    url: string,
    formData: FormData,
    config?: AxiosRequestConfig
) =>
    afterSuccessfulMutation(
        axiosInstance.patch(url, formData, { timeout: 120000, ...config }),
    );
