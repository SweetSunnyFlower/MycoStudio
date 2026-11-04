import logoUrl from "@/assets/logo.png";

/** 应用 logo（项目根目录 logo.png 生成的图标同源） */
export function Logo({ className }: { className?: string }) {
  return (
    <img
      src={logoUrl}
      alt="蘑菇 Myco Studio"
      draggable={false}
      className={"select-none rounded-[22%] object-cover " + (className ?? "")}
    />
  );
}
