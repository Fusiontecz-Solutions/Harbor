import { useMemo, useState } from "react";
import { ArrowLeftRight, Loader2, Phone, Search, Undo2 } from "lucide-react";
import { toast } from "react-toastify";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { fetchSenderAssignments, type SenderAssignment } from "@/services/messaging/messagingApi";
import {
    getAdminToken,
    getImpersonator,
    switchBackToAdmin,
    switchToUser,
} from "@/lib/impersonation";
import { normalizeRoleKey, resolveEffectiveRole, resolveSessionUser } from "@/lib/sessionRole";

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

const userLabel = (u: { firstName?: string | null; lastName?: string | null; email?: string | null }) =>
    `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email || "";

/**
 * Only agents are offered: Harbor admits Super Admins and agents alone, so
 * switching into any other role would be signed straight back out by the
 * layout guard. Admins are also refused by the backend.
 */
const isSwitchTarget = (u: SenderAssignment) => normalizeRoleKey(u.role) === "AGENT";

export default function UserSwitcher() {
    const impersonator = getImpersonator();
    const role = normalizeRoleKey(resolveEffectiveRole(undefined));
    const isAdmin = role === "SUPER_ADMIN" || role === "ADMIN";
    const currentUser = resolveSessionUser();

    const [users, setUsers] = useState<SenderAssignment[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [switchingId, setSwitchingId] = useState<string | null>(null);
    const [query, setQuery] = useState("");

    const loadUsers = async () => {
        setLoading(true);
        try {
            // While switched, the live token is the agent's and cannot list
            // users; the parked admin token authorizes this call instead.
            const adminToken = getAdminToken();
            const rows = await fetchSenderAssignments({
                skipCache: true,
                headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : undefined,
            });
            setUsers(rows.filter(isSwitchTarget));
        } catch (error: any) {
            toast.error(error?.response?.data?.message || "Failed to load users");
        } finally {
            setLoading(false);
        }
    };

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        const list = users ?? [];
        if (!q) return list;
        return list.filter((u) =>
            [userLabel(u), u.email, u.messagingSender?.phoneNumber, u.messagingSender?.label]
                .filter(Boolean)
                .some((v) => String(v).toLowerCase().includes(q)),
        );
    }, [users, query]);

    if (!isAdmin && !impersonator) return null;

    const handleSwitch = async (userId: string) => {
        if (switchingId) return;
        setSwitchingId(userId);
        try {
            await switchToUser(userId);
        } catch (error: any) {
            toast.error(error?.response?.data?.message || error?.message || "Could not switch user");
            setSwitchingId(null);
        }
    };

    const handleSwitchBack = async () => {
        if (switchingId) return;
        setSwitchingId("__admin__");
        try {
            await switchBackToAdmin();
        } catch {
            toast.error("Could not switch back");
            setSwitchingId(null);
        }
    };

    return (
        <DropdownMenu
            onOpenChange={(open: boolean) => {
                if (open && users === null && !loading) void loadUsers();
                if (!open) setQuery("");
            }}
        >
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className={
                        impersonator
                            ? "inline-flex items-center gap-1.5 rounded-full border border-amber-400 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                            : "inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                    }
                    title={impersonator ? "You are acting as another user" : "Switch to a user's account"}
                >
                    <ArrowLeftRight className="h-3.5 w-3.5 shrink-0" />
                    <span className="hidden max-w-[160px] truncate sm:inline">
                        {impersonator ? `Viewing as ${userLabel(currentUser ?? {})}` : "Switch user"}
                    </span>
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80 p-0">
                {impersonator && (
                    <>
                        <DropdownMenuItem
                            className="m-1 cursor-pointer"
                            onSelect={(e: Event) => {
                                e.preventDefault();
                                void handleSwitchBack();
                            }}
                        >
                            {switchingId === "__admin__" ? (
                                <Loader2 className="animate-spin" />
                            ) : (
                                <Undo2 />
                            )}
                            <span className="truncate">
                                Back to my account
                                {impersonator.user ? ` (${userLabel(impersonator.user)})` : ""}
                            </span>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="my-0" />
                    </>
                )}
                <DropdownMenuLabel className="px-3 pt-2 text-xs font-semibold text-muted-foreground">
                    Switch to user
                </DropdownMenuLabel>
                <div className="relative px-2 pb-2">
                    <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => e.stopPropagation()}
                        placeholder="Search name or number"
                        className="h-8 pl-7 text-sm"
                        autoFocus
                    />
                </div>
                <DropdownMenuSeparator className="my-0" />
                <div className="max-h-72 overflow-y-auto p-1">
                    {loading ? (
                        <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" /> Loading users…
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="py-6 text-center text-sm text-muted-foreground">No users found</div>
                    ) : (
                        filtered.map((u) => {
                            const isCurrent = currentUser?.id === u.id;
                            const sender = u.messagingSender;
                            return (
                                <DropdownMenuItem
                                    key={u.id}
                                    disabled={isCurrent || Boolean(switchingId)}
                                    className="cursor-pointer items-start"
                                    onSelect={(e: Event) => {
                                        e.preventDefault();
                                        void handleSwitch(u.id);
                                    }}
                                >
                                    <div className="flex min-w-0 flex-1 flex-col">
                                        <span className="truncate font-medium text-foreground">
                                            {userLabel(u)}
                                            {isCurrent ? " (current)" : ""}
                                        </span>
                                        <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                                            <Phone className="h-3 w-3" />
                                            {sender?.phoneNumber
                                                ? `${formatSenderNumber(sender.phoneNumber)}${sender.label ? ` · ${sender.label}` : ""}`
                                                : "No number assigned (default)"}
                                        </span>
                                    </div>
                                    {switchingId === u.id && <Loader2 className="mt-0.5 animate-spin" />}
                                </DropdownMenuItem>
                            );
                        })
                    )}
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
