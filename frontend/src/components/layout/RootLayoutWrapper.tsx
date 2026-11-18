import { useEffect } from "react";
import { Outlet, useLocation } from "react-router";
import Header from "../sidebar/Header";
import { useSidebar } from "@/components/ui/sidebar";

const RootLayoutWrapper = () => {
    const { state, isMobile } = useSidebar();
    const location = useLocation();

    useEffect(() => {
        window.scrollTo({ top: 0, left: 0, behavior: "smooth" });
    }, [location.pathname]);

    return (
        <main
            // On phones the sidebar is a slide-over sheet that takes no width.
            className={`mx-0 min-w-0 ${isMobile ? "w-full" : state === "expanded" ? "w-[calc(100%-var(--sidebar-width))]" : "w-[calc(100%-var(--sidebar-width-icon))]"}`}
        >
            <Header />
            <Outlet />
        </main>
    );
};

export default RootLayoutWrapper;
