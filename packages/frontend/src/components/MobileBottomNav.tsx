'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface NavItem {
  label: string;
  href: string;
  icon?: React.ReactNode;
  active?: boolean;
}

interface Props {
  items: NavItem[];
  showLabels?: boolean;
}

export default function MobileBottomNav({ items, showLabels = true }: Props) {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 block border-t border-gray-200 bg-white md:hidden">
      <div className="grid h-16 grid-cols-4">
        {items.slice(0, 4).map((item, i) => {
          const isActive = item.active || pathname === item.href;
          return (
            <Link key={i} href={item.href} className={`flex flex-col items-center justify-center ${isActive ? 'text-blue-600' : 'text-gray-500'}`}>
              {item.icon}
              {showLabels && <span className="mt-1 text-xs">{item.label}</span>}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}