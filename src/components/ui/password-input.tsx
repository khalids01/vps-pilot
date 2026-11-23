import { Eye, EyeOff } from "lucide-react";
import { type ComponentProps, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Input } from "./input";

export function PasswordInput({
  className,
  value,
  disabled,
  ...props
}: Omit<ComponentProps<typeof Input>, "type">) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!value || disabled) setVisible(false);
  }, [value, disabled]);
  return (
    <div className="relative">
      <Input
        {...props}
        value={value}
        disabled={disabled}
        type={visible ? "text" : "password"}
        className={cn("h-10 pr-11", className)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute right-1.5 top-1.5 text-muted-foreground hover:text-foreground"
        disabled={disabled}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  );
}
