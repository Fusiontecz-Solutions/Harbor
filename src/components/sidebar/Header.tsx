import type { RootState } from "@/redux/store"
import { PanelLeftClose, PanelLeftOpen, Phone, Wallet } from "lucide-react"
import { useEffect, useState } from "react"
import { useSelector } from "react-redux"
import type { user } from "../../redux/slices/authSlice";
import { useSidebar } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { fetchMessagingConfig, type MessagingConfig } from "@/services/messaging/messagingApi";

import { useLocation, useNavigate } from "react-router";
import UserSwitcher from "./UserSwitcher";

/** NANP display format; anything else is left as provided. */
const formatSenderNumber = (value: string): string => {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("1")) {
        return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    if (digits.length === 10) {
        return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    return value;
};

// Map routes to page titles
const getPageTitle = (pathname: string): string => {
    if (pathname === '/' || pathname === '') return 'Dashboard';
    if (pathname.startsWith('/clients') || pathname.startsWith('/create-clients')) return 'Clients';
    if (pathname.startsWith('/applications') || pathname.startsWith('/create-applications')) return 'Applications';
    if (pathname.startsWith('/application-details')) return 'Application';
    if (pathname.startsWith('/notifications')) return 'Notifications';
    if (pathname.startsWith('/user-setting') || pathname.startsWith('/settings')) return 'Settings';
    if (pathname.includes('terms-offer')) return 'Create Offer';
    if (pathname.startsWith('/letter-generator')) return 'Letters';
    if (pathname.startsWith('/inbox')) return 'Inbox';
    if (pathname.startsWith('/broadcasts')) return 'Broadcasts';
    if (pathname.startsWith('/messaging-contacts')) return 'Contacts & DNC';
    if (pathname.startsWith('/messaging-senders')) return 'Sending Numbers';
    if (pathname.startsWith('/lead-distribution')) return 'Lead Distribution';
    if (pathname.startsWith('/send-windows')) return 'Send Windows';
    if (pathname.startsWith('/messaging-performance')) return 'Performance';
    return 'Contract Workflow';
};

const Header = () => {

    const { state, setOpen } = useSidebar();
    const [user, setUser] = useState<user>()
    const { loading, data } = useSelector((state: RootState) => state.login)
    const { pathname } = useLocation();
    const navigate = useNavigate();

    // Get page title based on current route
    const pageTitle = getPageTitle(pathname);

    /**
     * The number this user sends SMS and broadcasts from.
     *
     * Users can be assigned different senders, and their inbox only shows the
     * conversations on their own number — so which number they are is no longer
     * something they can assume, and it belongs somewhere always visible rather
     * than only inside the inbox.
     *
     * Failures are swallowed: messaging being unreachable must never break the
     * header on every other page.
     */
    const [messagingConfig, setMessagingConfig] = useState<MessagingConfig | null>(null);
    useEffect(() => {
        let cancelled = false;
        const load = () => {
            fetchMessagingConfig()
                .then((cfg) => {
                    if (!cancelled) setMessagingConfig(cfg);
                })
                .catch(() => undefined);
        };
        load();
        const timer = window.setInterval(load, 15_000);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, []);

    useEffect(() => {
        setUser(data?.user)
        if (!data.user) {
            const user = localStorage.getItem('user')
            if (user) {
                setUser(JSON.parse(user))
            }
            else {
                setUser(undefined)
            }
        }

    }, [data, loading])

    return (
        <header className="sticky top-0 z-40 border-b border-border bg-card app-header-scroll-compensate">
            <div className="w-full mx-auto px-6">
                <div className="h-16 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        {state === "expanded" ? (
                            <Button variant="outline" size={"sm"} onClick={() => setOpen(false)}>
                                <PanelLeftClose size={20} />
                            </Button>
                        ) : (
                            <Button variant="outline" size={"sm"} onClick={() => setOpen(true)}>
                                <PanelLeftOpen size={20} />
                            </Button>
                        )}
                        <h1 className="text-xl font-semibold text-muted-foreground font-inter">
                            {pageTitle}
                        </h1>
                    </div>
                    <div className="flex items-center gap-3">
                        {messagingConfig?.prepaid && (
                            <span
                                className={cn(
                                    "hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs md:inline-flex",
                                    messagingConfig.prepaid.balance <= 0
                                        ? "border-destructive/40 bg-destructive/10 text-destructive"
                                        : "border-border bg-muted/50 text-muted-foreground",
                                )}
                                title={`Prepaid SMS balance (${messagingConfig.prepaid.pricePerUnit} ${messagingConfig.prepaid.currency} per ${messagingConfig.prepaid.chargeBy === "segments" ? "segment" : "message"})`}
                            >
                                <Wallet className="h-3.5 w-3.5 shrink-0" />
                                <span className="font-medium text-foreground">
                                    {new Intl.NumberFormat(undefined, {
                                        style: "currency",
                                        currency: messagingConfig.prepaid.currency || "USD",
                                        minimumFractionDigits: 2,
                                        maximumFractionDigits: 2,
                                    }).format(messagingConfig.prepaid.balance)}
                                </span>
                            </span>
                        )}
                        {messagingConfig?.defaultSender && (
                            <span
                                className="hidden items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground md:inline-flex"
                                title={
                                    messagingConfig.senderAssigned
                                        ? "Your assigned sending number — messages and broadcasts you send go out from this number"
                                        : "You have no number assigned, so you send from the company default"
                                }
                            >
                                <Phone className="h-3.5 w-3.5 shrink-0" />
                                <span className="font-medium text-foreground">
                                    {formatSenderNumber(messagingConfig.defaultSender)}
                                </span>
                                {messagingConfig.defaultSenderLabel ? (
                                    <span className="hidden lg:inline">· {messagingConfig.defaultSenderLabel}</span>
                                ) : !messagingConfig.senderAssigned ? (
                                    <span className="hidden lg:inline">· default</span>
                                ) : null}
                            </span>
                        )}
                        <UserSwitcher />
                        <ThemeToggle />
                        <button
                            type="button"
                            onClick={() => navigate("/user-setting")}
                            className="flex items-center gap-2 cursor-pointer"
                        >
                            <div className="h-8 w-8 rounded-full bg-[image:var(--brand-gradient)] text-white text-xs font-semibold flex items-center justify-center">{user?.firstName?.slice(0, 1).toUpperCase()}{user?.lastName?.slice(0, 1).toUpperCase()}</div>
                            <div className="hidden sm:block">
                                <div className="text-sm font-medium text-foreground capitalize">{user?.firstName + ' ' + user?.lastName || 'John Doe'}</div>
                            </div>
                        </button>
                    </div>
                </div>
            </div>
        </header>
    )
}

export default Header