import { forwardRef } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'group inline-flex items-center justify-center whitespace-nowrap rounded-full text-sm font-medium transition-[transform,background-color,box-shadow] duration-500 ease-fluid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        // The teal call-to-action: a keyline in the page colour plus a soft teal ring (Figma "Button").
        default: 'border-2 border-background bg-primary text-primary-foreground shadow-cta hover:bg-primary-dark',
        outline: 'bg-card text-foreground ring-1 ring-foreground/10 hover:bg-muted',
        ghost: 'text-foreground hover:bg-muted',
      },
      size: {
        default: 'px-4 py-1.5',
        // Leaves room on the right for a ButtonIcon, which sits flush with the inner edge.
        lg: 'gap-4 py-1.5 pl-5 pr-1.5',
        icon: 'size-[42px] p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = 'Button';

/** Trailing icon nested in its own circle; it drifts up and right when the button is hovered. */
function ButtonIcon({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'flex size-8 items-center justify-center rounded-full bg-white/15 transition-transform duration-500 ease-fluid group-hover:-translate-y-px group-hover:translate-x-1 group-hover:scale-105',
        className,
      )}
    >
      {children}
    </span>
  );
}

export { Button, ButtonIcon };
