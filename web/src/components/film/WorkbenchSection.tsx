import type { ReactNode } from "react";

export function WorkbenchSection({ id, title, children, wide = false }: { id: string; title: string; children: ReactNode; wide?: boolean }) {
  return <section id={id} data-testid={`film-section-${id}`} className={`ob-card scroll-mt-32 p-4 sm:p-5 ${wide ? "lg:col-span-2" : ""}`}>
    <h2 className="mb-4 text-base font-semibold">{title}</h2>
    {children}
  </section>;
}
