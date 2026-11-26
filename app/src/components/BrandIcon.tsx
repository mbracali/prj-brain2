// The BRAIN2 app icon, from the PNG generated out of res/ (scripts/make-icons.sh).
import icon from "../../build/icons/256x256.png";

export function BrandIcon({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <img
      className={`brand-icon${className ? ` ${className}` : ""}`}
      src={icon}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
