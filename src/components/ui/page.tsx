import * as React from "react";
import { cn } from "@/lib/utils";
import { Card } from "./card";

export interface PageHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}

export function PageHeader({
  icon,
  title,
  description,
  actions,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
      {...props}
    >
      <div className="flex items-start gap-3 min-w-0">
        {icon && (
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent [&_svg]:size-5">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground truncate">
            {title}
          </h1>
          {description && (
            <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export interface StatCardProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  trend?: "up" | "down" | "neutral";
  trendValue?: React.ReactNode;
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  trend,
  trendValue,
  className,
  ...props
}: StatCardProps) {
  return (
    <Card className={cn("p-4", className)} {...props}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
            {value}
          </p>
          {(hint || trendValue) && (
            <p
              className={cn(
                "mt-1 text-xs",
                trend === "up" && "text-success",
                trend === "down" && "text-destructive",
                (!trend || trend === "neutral") && "text-muted-foreground",
              )}
            >
              {trendValue}
              {trendValue && hint ? " · " : ""}
              {hint}
            </p>
          )}
        </div>
        {icon && (
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground [&_svg]:size-4">
            {icon}
          </div>
        )}
      </div>
    </Card>
  );
}

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/40 p-10 text-center",
        className,
      )}
      {...props}
    >
      {icon && (
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-6">
          {icon}
        </div>
      )}
      <div>
        <p className="text-base font-semibold text-foreground">{title}</p>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
