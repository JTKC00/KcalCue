import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function BaseIcon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function CameraIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M5 7h3l1.2-2h5.6L16 7h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" />
      <circle cx="12" cy="13" r="3.5" />
    </BaseIcon>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M5 20h14" />
    </BaseIcon>
  );
}

export function SparklesIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="m12 3 1.2 3.2L16.5 7.5l-3.3 1.3L12 12l-1.2-3.2-3.3-1.3 3.3-1.3L12 3Z" />
      <path d="m18.5 13 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
      <path d="m6 14 .7 1.8 1.8.7-1.8.7L6 19l-.7-1.8-1.8-.7 1.8-.7L6 14Z" />
    </BaseIcon>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M12 3 4.5 6v5.3c0 4.5 3 7.8 7.5 9.7 4.5-1.9 7.5-5.2 7.5-9.7V6L12 3Z" />
      <path d="m9 12 2 2 4-4" />
    </BaseIcon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M12 5v14M5 12h14" />
    </BaseIcon>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
    </BaseIcon>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M20 7v5h-5" />
      <path d="M19 12a7 7 0 1 0-2 5" />
    </BaseIcon>
  );
}

export function ImageIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9" r="1.5" />
      <path d="m4 17 4.5-4.5 3 3 2-2L20 19" />
    </BaseIcon>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 9v4M12 17h.01" />
    </BaseIcon>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M5 12h14M14 7l5 5-5 5" />
    </BaseIcon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="m5 12 4 4L19 6" />
    </BaseIcon>
  );
}


export function HomeIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="m4 10 8-6 8 6" />
      <path d="M6.5 9.5V20h11V9.5" />
      <path d="M10 20v-6h4v6" />
    </BaseIcon>
  );
}

export function HistoryIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5" />
      <path d="M4 4v4.5h4.5" />
      <path d="M12 8v4l2.5 1.5" />
    </BaseIcon>
  );
}

export function JournalIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M6 3.5h10a2 2 0 0 1 2 2V20H8a2 2 0 0 1-2-2V3.5Z" />
      <path d="M8 3.5V18a2 2 0 0 0 2 2" />
      <path d="M11 8h4M11 12h4" />
    </BaseIcon>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.5 20c.6-3.6 3-5.5 6.5-5.5s5.9 1.9 6.5 5.5" />
    </BaseIcon>
  );
}


export type FoodStampKind =
  | "apple"
  | "bread"
  | "carrot"
  | "cup"
  | "tomato"
  | "rice"
  | "milk"
  | "bowl"
  | "salad"
  | "soup"
  | "tea";

export function FoodStampIcon({ kind, ...props }: IconProps & { kind: FoodStampKind }) {
  const common = { ...props };
  if (kind === "apple") {
    return (
      <BaseIcon {...common}>
        <path d="M12 8c-1.6-2.1-4.7-2.4-6.4-.4-2.5 3 .4 10.8 4.1 12.2.8.3 1.5-.1 2.3-.7.8.6 1.5 1 2.3.7 3.7-1.4 6.6-9.2 4.1-12.2-1.7-2-4.8-1.7-6.4.4Z" />
        <path d="M12 7c.1-2 1.2-3.4 3.4-4" />
        <path d="M12.6 5.5c1.7-1.1 3.6-.9 4.8.2-1.6 1.2-3.5 1.4-4.8-.2Z" />
      </BaseIcon>
    );
  }
  if (kind === "bread") {
    return (
      <BaseIcon {...common}>
        <path d="M5.2 9.2C3.7 8.8 3 7.7 3 6.5 3 4.6 4.7 3 6.8 3h10.4C19.3 3 21 4.6 21 6.5c0 1.2-.7 2.3-2.2 2.7V20H5.2V9.2Z" />
        <path d="M9 7h.01M13 7h.01M17 7h.01" />
      </BaseIcon>
    );
  }
  if (kind === "carrot") {
    return (
      <BaseIcon {...common}>
        <path d="m8 8 8 8-6.7 4.2C8 21 6.4 19.4 7.2 18.1L11.4 11Z" />
        <path d="M13 9c.7-2.6 2.4-4.3 5-5-.2 2.8-1.4 4.8-3.8 6" />
        <path d="M12.6 8.4C11.8 6 10.2 4.5 8 4c.1 2.5 1.2 4.2 3.4 5" />
      </BaseIcon>
    );
  }
  if (kind === "cup" || kind === "tea") {
    return (
      <BaseIcon {...common}>
        <path d="M5 8h11v8a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V8Z" />
        <path d="M16 10h1.8a2.2 2.2 0 1 1 0 4.4H16" />
        {kind === "tea" ? <path d="M8 12c1 .8 2 .8 3 0s2-.8 3 0" /> : <path d="M8 5c0-1 1-1 1-2M12 5c0-1 1-1 1-2" />}
      </BaseIcon>
    );
  }
  if (kind === "tomato") {
    return (
      <BaseIcon {...common}>
        <circle cx="12" cy="13" r="7" />
        <path d="m12 6 1.2-2 1.1 2 2-.6-.8 2 1.7 1.2-2.2.2.2 2-1.8-1-1.2 1.6-1.2-1.6-1.8 1 .2-2-2.2-.2L8.5 7.4l-.8-2 2 .6L10.8 4 12 6Z" />
      </BaseIcon>
    );
  }
  if (kind === "rice") {
    return (
      <BaseIcon {...common}>
        <path d="M5 14c0-4.2 3.1-8 7-8s7 3.8 7 8" />
        <path d="M4 14h16l-2.2 6H6.2L4 14Z" />
        <path d="M9 10h.01M12 9h.01M15 10h.01" />
      </BaseIcon>
    );
  }
  if (kind === "milk") {
    return (
      <BaseIcon {...common}>
        <path d="M8 3h7l2 4v14H7V7l1-4Z" />
        <path d="M8 3l3 4h6M11 7v14" />
        <path d="M13.5 11.5c1.6.3 2.5 1.2 2.7 2.7-1.5-.1-2.5-1-2.7-2.7Z" />
      </BaseIcon>
    );
  }
  if (kind === "bowl" || kind === "salad" || kind === "soup") {
    return (
      <BaseIcon {...common}>
        {kind === "salad" && <><path d="M8 9c-1-2 .2-3.8 2.2-4 .7 1.5.3 3-1 4" /><path d="M15 9c1-1.8.5-3.6-1.3-4.4-1 1.4-.8 3 .3 4.2" /></>}
        {kind === "soup" && <><path d="M8 8c0-1 1-1 1-2M12 8c0-1 1-1 1-2M16 8c0-1 1-1 1-2" /></>}
        <path d="M4 11h16c-.6 5.5-3.4 9-8 9s-7.4-3.5-8-9Z" />
        <path d="M7 20h10" />
      </BaseIcon>
    );
  }
  return null;
}
