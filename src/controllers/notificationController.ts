// @ts-nocheck
import type { Request, Response } from 'express';
import prisma from '../config/prismaClient';
import { buildAgentApplicationVisibilityWhere } from '../services/applicationService';
import {
    sendDocumentRequestEmail,
} from '../services/emailService';
import {
    findFulfilledDocumentForRequest,
    getDocumentRequestConfig,
    humanizeDocumentRequestLabels,
} from '../constants/documentRequestTypes';
import { loadDocumentRequestFulfillmentContext } from '../services/documentRequestFulfillmentService';
import { resolveCrmFrontendBaseUrl } from '../utils/crmFrontendUrl';

// Helper to map Prisma Application (with includes) to the API shape previously returned by Mongoose
const mapApplicationToApi = (app: any) => {
    if (!app) return app;
    const {
        id,
        applicationId,
        priority,
        type,
        note,
        currentQueue,
        currentState,
        createdAt,
        updatedAt,
        referringAgent,
        salesRepresentative,
        createdBy,
        client,
        iso,
        files,
        ...rest
    } = app;

    const mapUserLite = (u: any) =>
        u
            ? {
                  _id: u.id,
                  id: u.id,
                  firstName: u.firstName,
                  lastName: u.lastName,
                  email: u.email,
              }
            : undefined;

    const mappedClient =
        client &&
        ({
            ...client,
            _id: client.id,
            id: client.id,
            clientId: client.clientId,
            business: {
                name: client.businessName,
                email: client.businessEmail || '',
                number: client.businessNumber || '',
                website: client.businessWebsite || '',
                incorporationDate: client.businessIncorporationDate,
                incorporationState: client.businessIncorporationState || '',
                businessEntityType: client.businessEntityType || '',
                einNumber: client.businessEinNumber || '',
                annualRevenue: client.businessAnnualRevenue ?? undefined,
                monthlyRevenue: client.businessMonthlyRevenue ?? undefined,
                address: {
                    address1: client.businessAddress1 || '',
                    address2: client.businessAddress2 || '',
                    city: client.businessCity || '',
                    state: client.businessState || '',
                    zipCode: client.businessZipCode || '',
                },
            },
            owner: {
                firstName: client.ownerFirstName,
                middleName: client.ownerMiddleName || '',
                lastName: client.ownerLastName,
                email: client.ownerEmail || '',
                mobileNumber: client.ownerMobileNumber || '',
                dateOfBirth: client.ownerDateOfBirth,
                ssn: client.ownerSsn || '',
                ficoScore: client.ownerFicoScore ?? undefined,
                ownershipStartDate: client.ownerOwnershipStartDate,
                ownershipPercentage: client.ownerOwnershipPercentage ?? undefined,
                address: {
                    address1: client.ownerAddress1 || '',
                    address2: client.ownerAddress2 || '',
                    city: client.ownerCity || '',
                    state: client.ownerState || '',
                    zipCode: client.ownerZipCode || '',
                },
            },
        } as any);

    const mappedFiles =
        files?.map((f: any) => ({
            _id: f.id,
            id: f.id,
            url: f.url,
            publicId: f.publicId,
            originalName: f.originalName,
            mimeType: f.mimeType,
            size: f.size,
            uploadedAt: f.uploadedAt,
        })) || [];

    return {
        ...rest,
        _id: id,
        id,
        applicationId,
        priority,
        type,
        note,
        currentQueue,
        currentState,
        createdAt,
        updatedAt,
        referringAgent: mapUserLite(referringAgent),
        salesRepresentative: mapUserLite(salesRepresentative),
        createdBy: mapUserLite(createdBy),
        client: mappedClient,
        iso: iso
            ? {
                  _id: iso.id,
                  id: iso.id,
                  name: iso.name,
                  email: iso.email || '',
              }
            : undefined,
        files: mappedFiles,
    };
};

const APPLICATION_INCLUDE_FOR_DOCUMENT_REQUEST = {
    referringAgent: { select: { id: true, firstName: true, lastName: true, email: true } },
    salesRepresentative: { select: { id: true, firstName: true, lastName: true, email: true } },
    iso: { select: { id: true, name: true, email: true } },
    client: true,
};

// Map Prisma Notification to previous API shape (including nested documentRequestDetails)
const mapNotificationToApi = (notification: any) => {
    if (!notification) return notification;

    const {
        id,
        title,
        message,
        type,
        recipient,
        recipientId,
        application,
        applicationId,
        documentRequestedDocuments,
        documentRequestAdditional,
        isRead,
        readAt,
        createdBy,
        createdById,
        createdAt,
        updatedAt,
        ...rest
    } = notification;

    return {
        ...rest,
        _id: id,
        id,
        title,
        message,
        type,
        recipient: recipient
            ? {
                  _id: recipient.id,
                  id: recipient.id,
                  firstName: recipient.firstName,
                  lastName: recipient.lastName,
                  email: recipient.email,
              }
            : recipientId, // in queries where recipient not included, keep id
        application: application
            ? {
                  _id: application.id,
                  id: application.id,
                  applicationId: application.applicationId,
                  priority: application.priority,
                  type: application.type,
                  currentQueue: application.currentQueue,
                  currentState: application.currentState,
              }
            : applicationId,
        documentRequestDetails:
            documentRequestedDocuments || documentRequestAdditional !== undefined
                ? {
                      requestedDocuments: documentRequestedDocuments || [],
                      requestAdditional: !!documentRequestAdditional,
                  }
                : undefined,
        isRead,
        readAt,
        createdBy: createdBy
            ? {
                  _id: createdBy.id,
                  id: createdBy.id,
                  firstName: createdBy.firstName,
                  lastName: createdBy.lastName,
                  email: createdBy.email,
              }
            : createdById,
        createdAt,
        updatedAt,
    };
};

class NotificationController {
    // Send document request notification (in-app and/or ISO email via SendGrid)
    async sendDocumentRequest(req: Request, res: Response) {
        try {
            const {
                applicationId,
                requestedDocuments,
                requestAdditional,
                reason,
                additionalComments,
                isoEmail,
                additionalToEmails,
                ccEmails,
            } = req.body;
            const currentUserRole = (req as any).user?.role;
            const isFinalUnderwriter = currentUserRole === 'FINAL_UNDERWRITER';
            const isIsoEmailRequest = Object.prototype.hasOwnProperty.call(req.body, 'isoEmail');

            if (!applicationId) {
                return res.status(400).json({
                    success: false,
                    message: 'Application ID is required',
                });
            }
            if (isFinalUnderwriter && (!reason || String(reason).trim() === '')) {
                return res.status(400).json({
                    success: false,
                    message: 'Reason is required when sending back for documentation',
                });
            }

            let documentsArray: string[] = [];
            if (requestedDocuments !== undefined && requestedDocuments !== null && Array.isArray(requestedDocuments)) {
                documentsArray = requestedDocuments
                    .map((d) => String(d || '').trim())
                    .filter(Boolean);
            }

            if (isIsoEmailRequest && documentsArray.length === 0 && !requestAdditional) {
                return res.status(400).json({
                    success: false,
                    message: 'Select at least one document type or Request Additional Documents',
                });
            }

            const reasonText = reason && String(reason).trim() ? String(reason).trim() : '';
            const additionalCommentsText =
                additionalComments && String(additionalComments).trim()
                    ? String(additionalComments).trim()
                    : '';
            const fullNote = additionalCommentsText
                ? `${reasonText}\n\nAdditional comments: ${additionalCommentsText}`
                : reasonText;

            const applicationStr = String(applicationId);
            let application = null;

            if (/^\d+$/.test(applicationStr)) {
                application = await prisma.application.findUnique({
                    where: { applicationId: Number(applicationStr) },
                    include: APPLICATION_INCLUDE_FOR_DOCUMENT_REQUEST,
                });
            } else {
                application = await prisma.application.findUnique({
                    where: { id: applicationStr },
                    include: APPLICATION_INCLUDE_FOR_DOCUMENT_REQUEST,
                });
            }

            if (!application) {
                return res.status(404).json({
                    success: false,
                    message: 'Application not found',
                });
            }

            const createdBy = (req as any).user?.id;
            if (!createdBy) {
                return res.status(401).json({
                    success: false,
                    message: 'User authentication required',
                });
            }

            const app = application as any;
            const client = app.client;
            const clientName =
                client?.businessName ||
                `${client?.ownerFirstName || ''} ${client?.ownerLastName || ''}`.trim() ||
                'Unknown Client';
            const applicationIdNumber = app.applicationId || 'N/A';

            const primaryIsoEmail = isIsoEmailRequest ? String(isoEmail || '').trim() : '';
            const extraToEmails = Array.isArray(additionalToEmails)
                ? additionalToEmails.map((e) => String(e || '').trim()).filter(Boolean)
                : [];
            const emailCcList = Array.isArray(ccEmails)
                ? ccEmails.map((e) => String(e || '').trim()).filter(Boolean)
                : [];
            const emailToList = [...(primaryIsoEmail ? [primaryIsoEmail] : []), ...extraToEmails];
            const uniqueEmailTo = [...new Set(emailToList.map((e) => e.toLowerCase()))].map(
                (lower) => emailToList.find((e) => e.toLowerCase() === lower) || lower,
            );

            if (isIsoEmailRequest && uniqueEmailTo.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'At least one recipient email (ISO To or Additional To) is required',
                });
            }

            const recipientIds = new Set<string>();
            const addIfNotSender = (id: string) => {
                const sid = String(id);
                if (sid && sid !== String(createdBy)) recipientIds.add(sid);
            };
            const agentRecipientId = app.referringAgent?.id || app.salesRepresentative?.id;
            if (agentRecipientId) addIfNotSender(agentRecipientId);
            if (app.referringAgentId) addIfNotSender(app.referringAgentId);
            if (app.salesRepresentativeId) addIfNotSender(app.salesRepresentativeId);
            if (isFinalUnderwriter) {
                const underwriters = await prisma.user.findMany({
                    where: { role: 'UNDERWRITER' },
                    select: { id: true },
                });
                underwriters.forEach((u) => addIfNotSender(u.id));
            }

            if (recipientIds.size === 0 && uniqueEmailTo.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'No recipient available for this notification',
                });
            }

            const notificationTitle =
                documentsArray.length > 0
                    ? 'Document Request Required'
                    : isFinalUnderwriter
                      ? 'Sent Back for Documentation (Final Underwriter)'
                      : 'Action Required';
            const notificationMessage =
                documentsArray.length > 0
                    ? `Document request for Application #${applicationIdNumber} - ${clientName}. Please provide the requested documents.`
                    : fullNote
                      ? `Action required for Application #${applicationIdNumber} - ${clientName}. ${fullNote}`
                      : `Action required for Application #${applicationIdNumber} - ${clientName}.`;

            const notificationData = {
                title: notificationTitle,
                message: notificationMessage,
                type: 'document_request',
                applicationId: application.id,
                documentRequestedDocuments: documentsArray,
                documentRequestAdditional: requestAdditional || false,
                createdById: createdBy,
            };

            let firstNotification: { id: string } | null = null;
            if (recipientIds.size > 0) {
                for (const recId of recipientIds) {
                    const created = await prisma.notification.create({
                        data: { ...notificationData, recipientId: String(recId) },
                    });
                    if (!firstNotification) firstNotification = created;
                }
            }

            const appUpdateData: { note?: string; currentQueue?: string; currentState?: string } = {};
            if (fullNote) appUpdateData.note = fullNote;
            if (isFinalUnderwriter) {
                appUpdateData.currentQueue = 'Underwriting';
                appUpdateData.currentState = 'In Progress';
            }

            if (Object.keys(appUpdateData).length > 0) {
                await prisma.application.update({
                    where: { id: application.id },
                    data: appUpdateData,
                });
            }

            if (isIsoEmailRequest && app.isoId && primaryIsoEmail) {
                try {
                    await prisma.iso.update({
                        where: { id: app.isoId },
                        data: { email: primaryIsoEmail },
                    });
                } catch (isoUpdateErr) {
                    console.error('Failed to persist ISO email after document request:', isoUpdateErr);
                }
            }

            let emailSent = false;
            let emailError: string | undefined;
            const emailedTo: string[] = [];
            const emailedCc: string[] = [];

            if (isIsoEmailRequest && uniqueEmailTo.length > 0) {
                const crmBase = resolveCrmFrontendBaseUrl();
                const businessApplicationId = app.applicationId ?? applicationIdNumber;
                const viewApplicationUrl = crmBase
                    ? `${crmBase.replace(/\/$/, '')}/application-details/${businessApplicationId}/documents`
                    : undefined;
                const emailResult = await sendDocumentRequestEmail({
                    to: uniqueEmailTo,
                    cc: emailCcList,
                    isoName: app.iso?.name || undefined,
                    clientName,
                    applicationNumber: applicationIdNumber,
                    requestedDocumentLabels: humanizeDocumentRequestLabels(documentsArray),
                    requestAdditional: Boolean(requestAdditional),
                    note: reasonText || undefined,
                    viewApplicationUrl,
                });
                emailSent = emailResult.sent;
                emailError = emailResult.error;
                if (emailSent) {
                    emailedTo.push(...uniqueEmailTo);
                    emailedCc.push(...emailCcList);
                }
            }

            try {
                const authUserForLog = {
                    id: createdBy,
                    role: (req as any).user?.role,
                } as any;
                const roleLabel = authUserForLog?.role
                    ? String(authUserForLog.role).toUpperCase().replace(/_/g, ' ')
                    : 'User';
                const actorName = (req as any).user?.name || '';
                const recipientLabel = isIsoEmailRequest ? 'the ISO' : 'the client';

                const refreshedForLog = await prisma.application.findUnique({
                    where: { id: application.id },
                    select: { currentQueue: true, currentState: true },
                });

                await prisma.applicationActivityLog.create({
                    data: {
                        applicationId: application.id,
                        userId: createdBy,
                        userRole: authUserForLog.role as any,
                        actionType: 'DOCUMENT_REQUESTED',
                        actionDescription:
                            `${roleLabel} ${actorName}`.trim() +
                            ` requested additional documents from ${recipientLabel}.`,
                        previousStatus: `${app.currentQueue} / ${app.currentState}`,
                        currentStatus: `${refreshedForLog?.currentQueue ?? app.currentQueue} / ${
                            refreshedForLog?.currentState ?? app.currentState
                        }`,
                        metadata: {
                            requestedDocuments: documentsArray,
                            requestAdditional: requestAdditional || false,
                            reason: reasonText,
                            additionalComments: additionalCommentsText,
                            emailedTo,
                            emailedCc,
                            documentRequestEmailSent: emailSent,
                        } as any,
                    },
                });
            } catch (logError) {
                console.error('Failed to create application activity log for document request:', logError);
            }

            const updatedApplicationRecord = await prisma.application.findUnique({
                where: { id: application.id },
                include: {
                    ...APPLICATION_INCLUDE_FOR_DOCUMENT_REQUEST,
                    createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
                    files: true,
                },
            });

            const notification = firstNotification;
            const populatedNotificationRecord = notification
                ? await prisma.notification.findUnique({
                      where: { id: notification.id },
                      include: {
                          recipient: { select: { id: true, firstName: true, lastName: true, email: true } },
                          application: {
                              select: {
                                  id: true,
                                  applicationId: true,
                                  priority: true,
                                  type: true,
                                  currentQueue: true,
                                  currentState: true,
                              },
                          },
                          createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
                      },
                  })
                : null;

            const populatedNotification = populatedNotificationRecord
                ? mapNotificationToApi(populatedNotificationRecord)
                : null;
            const mappedApplication = updatedApplicationRecord
                ? mapApplicationToApi(updatedApplicationRecord)
                : null;

            let message = 'Document request notification sent successfully';
            if (emailSent && recipientIds.size > 0) {
                message =
                    'Document request emailed to ISO and in-app notification sent successfully';
            } else if (emailSent) {
                message = 'Document request sent to ISO by email';
            }

            if (isIsoEmailRequest && uniqueEmailTo.length > 0 && !emailSent) {
                return res.status(502).json({
                    success: false,
                    message: `Document request saved but ISO email was not sent: ${emailError || 'Unknown error'}`,
                    data: populatedNotification,
                    application: mappedApplication,
                    emailSent: false,
                    emailError: emailError || 'Unknown error',
                    emailedTo,
                    emailedCc,
                });
            }

            return res.status(201).json({
                success: true,
                message,
                data: populatedNotification,
                application: mappedApplication,
                emailSent,
                emailError: emailError || undefined,
                emailedTo,
                emailedCc,
            });
        } catch (error: any) {
            console.error('Send document request notification error:', error?.message || error, error?.stack);
            const errMessage = error?.message || 'Internal server error';
            return res.status(500).json({
                success: false,
                message: errMessage,
            });
        }
    }

    /** In-app notifications for all active Final Underwriter users when an application enters their queue. */
    async notifyApplicationSentToFinalUnderwriter(req: Request, res: Response) {
        try {
            const { applicationId, underwriterName } = req.body;
            const createdBy = (req as any).user?.id;
            if (!createdBy) {
                return res.status(401).json({
                    success: false,
                    message: 'User authentication required',
                });
            }
            if (!applicationId) {
                return res.status(400).json({
                    success: false,
                    message: 'Application ID is required',
                });
            }

            const applicationStr = String(applicationId);
            let application = null;

            if (/^\d+$/.test(applicationStr)) {
                application = await prisma.application.findUnique({
                    where: { applicationId: Number(applicationStr) },
                    include: { client: true },
                });
            } else {
                application = await prisma.application.findUnique({
                    where: { id: applicationStr },
                    include: { client: true },
                });
            }

            if (!application) {
                return res.status(404).json({
                    success: false,
                    message: 'Application not found',
                });
            }

            const senderName =
                (underwriterName && String(underwriterName).trim()) ||
                String((req as any).user?.name || '').trim() ||
                'Underwriter';

            const clientName =
                (application as any).client?.businessName ||
                `${(application as any).client?.ownerFirstName || ''} ${(application as any).client?.ownerLastName || ''}`.trim() ||
                'Client';
            const appIdNumber = (application as any).applicationId ?? '';

            const title = `${senderName} forwarded an application for final review`;
            const message = `Application${appIdNumber ? ` #${appIdNumber}` : ''} for ${clientName} is ready for Final Underwriter review.`;

            const finalUnderwriters = await prisma.user.findMany({
                where: { role: 'FINAL_UNDERWRITER', isActive: true },
                select: { id: true },
            });

            const senderId = String(createdBy);
            const recipients = finalUnderwriters
                .map((u) => String(u.id))
                .filter((id) => id && id !== senderId);

            if (recipients.length === 0) {
                return res.status(201).json({
                    success: true,
                    message: 'No Final Underwriter recipients to notify',
                    data: { notified: 0 },
                });
            }

            await prisma.notification.createMany({
                data: recipients.map((recipientId) => ({
                    title,
                    message,
                    type: 'application_update',
                    recipientId,
                    applicationId: application.id,
                    createdById: senderId,
                })),
            });

            return res.status(201).json({
                success: true,
                message: 'Final Underwriter notified successfully',
                data: { notified: recipients.length },
            });
        } catch (error: any) {
            console.error('Notify Final Underwriter error:', error?.message || error, error?.stack);
            return res.status(500).json({
                success: false,
                message: error?.message || 'Internal server error',
            });
        }
    }

    // Get notifications for a user
    async getNotifications(req: Request, res: Response) {
        try {
            const userId = (req as any).user?.id;
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'User authentication required',
                });
            }

            const { isRead, limit, page } = req.query;

            // Parse and validate limit
            let limitNum = 50; // default
            if (limit !== undefined) {
                const parsedLimit = Number(limit);
                if (!isNaN(parsedLimit) && parsedLimit > 0) {
                    limitNum = Math.min(parsedLimit, 1000); // Cap at 1000 for performance
                }
            }

            // Parse and validate page
            let pageNum = 1;
            if (page !== undefined) {
                const parsedPage = Number(page);
                if (!isNaN(parsedPage) && parsedPage > 0) {
                    pageNum = parsedPage;
                }
            }

            const skip = (pageNum - 1) * limitNum;

            const role = String((req as any).user?.role || '').toUpperCase();
            const isSuperAdmin = role === 'SUPER_ADMIN' || role === 'SUPERADMIN';

            const personalOnlyRaw = req.query.personalOnly;
            const wantsPersonalOnly =
                personalOnlyRaw !== undefined &&
                (String(personalOnlyRaw).toLowerCase() === 'true' || String(personalOnlyRaw) === '1');

            // Super Admin without personalOnly: all notifications (agent / UW / FUW / etc.).
            // Super Admin with personalOnly=1: same inbox scoping as other roles (e.g. header bell).
            const where: any =
                isSuperAdmin && !wantsPersonalOnly ? {} : { recipientId: String(userId) };
            if (isRead !== undefined) {
                const isReadStr = String(isRead).toLowerCase();
                where.isRead = isReadStr === 'true' || isReadStr === '1';
            }

            const roleNorm = String((req as any).user?.role || '')
                .trim()
                .toUpperCase()
                .replace(/-/g, '_');
            if (roleNorm === 'AGENT' && userId) {
                const agentAppScope = buildAgentApplicationVisibilityWhere(String(userId));
                const existingAnd = where.AND
                    ? Array.isArray(where.AND)
                        ? where.AND
                        : [where.AND]
                    : [];
                where.AND = [
                    ...existingAnd,
                    {
                        OR: [{ applicationId: null }, { application: agentAppScope }],
                    },
                ];
            }

            const includeRelations = {
                recipient: { select: { id: true, firstName: true, lastName: true, email: true } },
                application: {
                    select: {
                        id: true,
                        applicationId: true,
                        priority: true,
                        type: true,
                        currentQueue: true,
                        currentState: true,
                    },
                },
                createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
            };

            const [notificationsRecords, total] = await Promise.all([
                prisma.notification.findMany({
                    where,
                    orderBy: { createdAt: 'desc' },
                    skip,
                    take: limitNum,
                    include: includeRelations,
                }),
                prisma.notification.count({ where }),
            ]);

            const notifications = notificationsRecords.map((notif: any) => mapNotificationToApi(notif));

            return res.status(200).json({
                success: true,
                data: notifications,
                pagination: {
                    currentPage: pageNum,
                    totalItems: total,
                    itemsPerPage: limitNum,
                    totalPages: Math.max(1, Math.ceil(total / limitNum)),
                },
            });
        } catch (error: any) {
            console.error('Get notifications error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Internal server error',
            });
        }
    }

    // Mark a single notification as read by its unique id. Only the matching record is updated.
    async markAsRead(req: Request, res: Response) {
        try {
            const { id: notificationId } = req.params;
            const userId = (req as any).user?.id;

            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'User authentication required',
                });
            }

            const notification = await prisma.notification.findUnique({ where: { id: notificationId } });
            if (!notification) {
                return res.status(404).json({
                    success: false,
                    message: 'Notification not found',
                });
            }

            const role = String((req as any).user?.role || '').toUpperCase();
            const isSuperAdmin = role === 'SUPER_ADMIN' || role === 'SUPERADMIN';

            if (notification.recipientId !== userId && !isSuperAdmin) {
                return res.status(403).json({
                    success: false,
                    message: 'Unauthorized to mark this notification as read',
                });
            }

            const updated = await prisma.notification.update({
                where: { id: notificationId },
                data: { isRead: true, readAt: new Date() },
            });

            const populatedNotification = {
                _id: updated.id,
                id: updated.id,
                title: updated.title,
                message: updated.message,
                type: updated.type,
                recipient: updated.recipientId,
                application: updated.applicationId || null,
                documentRequestDetails:
                    updated.documentRequestedDocuments || updated.documentRequestAdditional !== undefined
                        ? {
                              requestedDocuments: updated.documentRequestedDocuments || [],
                              requestAdditional: !!updated.documentRequestAdditional,
                          }
                        : undefined,
                isRead: updated.isRead,
                readAt: updated.readAt,
                createdBy: updated.createdById || null,
                createdAt: updated.createdAt,
                updatedAt: updated.updatedAt,
            };

            return res.status(200).json({
                success: true,
                message: 'Notification marked as read',
                data: populatedNotification,
            });
        } catch (error: any) {
            console.error('Mark notification as read error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Internal server error',
            });
        }
    }

    // Mark all notifications as read for a user (inbox). Super Admin may pass ?allRecipients=true to mark every notification in the system (ops / global feed).
    async markAllAsRead(req: Request, res: Response) {
        try {
            const userId = (req as any).user?.id;
            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'User authentication required',
                });
            }

            const role = String((req as any).user?.role || '').toUpperCase();
            const isSuperAdmin = role === 'SUPER_ADMIN' || role === 'SUPERADMIN';
            const allRecipientsRaw = req.query.allRecipients;
            const wantsAllRecipients =
                allRecipientsRaw !== undefined &&
                (String(allRecipientsRaw).toLowerCase() === 'true' || String(allRecipientsRaw) === '1');

            if (wantsAllRecipients) {
                if (!isSuperAdmin) {
                    return res.status(403).json({
                        success: false,
                        message: 'Only Super Admin can mark all notifications as read for every recipient',
                    });
                }
                const now = new Date();
                const result = await prisma.notification.updateMany({
                    where: { isRead: false },
                    data: { isRead: true, readAt: now },
                });
                return res.status(200).json({
                    success: true,
                    message: 'All notifications marked as read',
                    updatedCount: result.count,
                });
            }

            await prisma.notification.updateMany({
                where: { recipientId: userId, isRead: false },
                data: { isRead: true, readAt: new Date() },
            });

            return res.status(200).json({
                success: true,
                message: 'All notifications marked as read',
            });
        } catch (error: any) {
            console.error('Mark all notifications as read error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Internal server error',
            });
        }
    }

    // Delete a single notification (recipient can delete their own)
    async deleteNotification(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const userId = (req as any).user?.id;

            if (!userId) {
                return res.status(401).json({
                    success: false,
                    message: 'User authentication required',
                });
            }

            const notification = await prisma.notification.findUnique({ where: { id } });
            if (!notification) {
                return res.status(404).json({
                    success: false,
                    message: 'Notification not found',
                });
            }

            if (String(notification.recipientId) !== String(userId)) {
                return res.status(403).json({
                    success: false,
                    message: 'Unauthorized to delete this notification',
                });
            }

            await prisma.notification.delete({ where: { id } });

            return res.status(200).json({
                success: true,
                message: 'Notification deleted successfully',
            });
        } catch (error: any) {
            console.error('Delete notification error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Internal server error',
            });
        }
    }

    // Get document requests for an application
    async getDocumentRequestsByApplication(req: Request, res: Response) {
        try {
            const { applicationId } = req.params;

            if (!applicationId) {
                return res.status(400).json({
                    success: false,
                    message: 'Application ID is required',
                });
            }

            const applicationStr = String(applicationId);
            let application = null;

            if (/^\d+$/.test(applicationStr)) {
                application = await prisma.application.findUnique({
                    where: { applicationId: Number(applicationStr) },
                    include: { files: true },
                });
            } else {
                application = await prisma.application.findUnique({
                    where: { id: applicationStr },
                    include: { files: true },
                });
            }
            if (!application) {
                return res.status(404).json({
                    success: false,
                    message: 'Application not found',
                });
            }

            const fulfillmentContext = await loadDocumentRequestFulfillmentContext(application.id);
            const applicationFiles = fulfillmentContext?.applicationFiles ?? application.files ?? [];
            const contractFiles = fulfillmentContext?.contractFiles ?? [];

            // Get all document request notifications for this application
            const notificationsRecords = await prisma.notification.findMany({
                where: {
                    applicationId: application.id,
                    type: 'document_request',
                },
                orderBy: { createdAt: 'desc' },
                include: {
                    createdBy: {
                        select: { id: true, firstName: true, lastName: true, email: true },
                    },
                },
            });

            // Extract all unique requested documents and their status
            const documentMap = new Map<
                string,
                {
                    status: 'Complete' | 'Pending';
                    createdAt: Date;
                    requestedBy?: any;
                    message?: string;
                    label?: string;
                    fileUrl?: string;
                    fileId?: string;
                    contractUploadKey?: string;
                }
            >();
            const generalRequests: {
                name: string;
                status: 'Pending';
                createdAt: Date;
                requestedBy?: any;
                message?: string;
            }[] = [];

            notificationsRecords.forEach((notification: any) => {
                const requestedDocs = notification.documentRequestedDocuments || [];

                // Specific document requests
                requestedDocs.forEach((docSlug: string) => {
                    const config = getDocumentRequestConfig(docSlug);
                    const fulfilled = findFulfilledDocumentForRequest(docSlug, {
                        applicationFiles,
                        contractFiles,
                    });
                    const isUploaded = fulfilled != null;

                    if (
                        !documentMap.has(docSlug) ||
                        (documentMap.get(docSlug)?.createdAt &&
                            notification.createdAt > documentMap.get(docSlug)!.createdAt)
                    ) {
                        documentMap.set(docSlug, {
                            status: isUploaded ? 'Complete' : 'Pending',
                            createdAt: notification.createdAt,
                            requestedBy: notification.createdBy,
                            label: config?.label,
                            fileUrl: fulfilled?.url,
                            fileId: fulfilled?.fileId,
                            contractUploadKey: config?.contractUploadKey,
                        });
                    }
                });

                // General "Sent Back for Documentation" requests (no specific docs - e.g. from Final Underwriter)
                if (requestedDocs.length === 0 && notification.message) {
                    generalRequests.push({
                        name: 'Sent Back for Documentation',
                        status: 'Pending',
                        createdAt: notification.createdAt,
                        requestedBy: notification.createdBy,
                        message: notification.message,
                    });
                }
            });

            // Convert map to array, then append general requests (Final Underwriter send-back)
            const documents = Array.from(documentMap.entries()).map(([name, data]) => ({
                name,
                label: data.label,
                status: data.status,
                createdAt: data.createdAt,
                requestedBy: data.requestedBy,
                message: data.message,
                fileUrl: data.fileUrl,
                fileId: data.fileId,
                contractUploadKey: data.contractUploadKey,
            }));

            // Add general requests (sorted by createdAt desc)
            generalRequests
                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                .forEach((req) => {
                    documents.push({
                        name: req.name,
                        status: req.status,
                        createdAt: req.createdAt,
                        requestedBy: req.requestedBy,
                        message: req.message,
                    });
                });

            return res.status(200).json({
                success: true,
                data: documents,
            });
        } catch (error: any) {
            console.error('Get document requests by application error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Internal server error',
            });
        }
    }
}

const notificationController = new NotificationController();
export default notificationController;

