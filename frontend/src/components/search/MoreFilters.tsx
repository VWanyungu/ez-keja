import { Checkbox } from '@/components/ui/checkbox';
import type { ManagementType, SearchFilters } from '@/types/search';

interface MoreFiltersProps {
  values: SearchFilters;
  onChange: (next: SearchFilters) => void;
}

interface OptionProps {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

function Option({ label, checked, onCheckedChange }: OptionProps) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-[15px] leading-6">
      <Checkbox checked={checked} onCheckedChange={(state) => onCheckedChange(state === true)} />
      {label}
    </label>
  );
}

const GroupLabel = ({ children }: { children: React.ReactNode }) => (
  <p className="text-[11px] font-semibold uppercase leading-4 tracking-[0.06em] text-muted-foreground">{children}</p>
);

const MANAGEMENT: { type: ManagementType; label: string }[] = [
  { type: 'agent', label: 'Agent' },
  { type: 'landlord', label: 'Landlord' },
];

export function MoreFilters({ values, onChange }: MoreFiltersProps) {
  return (
    <div className="grid gap-8 px-5 pb-6 pt-5 md:grid-cols-2 md:gap-10">
      <div className="flex flex-col gap-3">
        <GroupLabel>Managed by</GroupLabel>
        {/* The API filters on one manager at a time, so ticking one clears the other. */}
        {MANAGEMENT.map(({ type, label }) => (
          <Option
            key={type}
            label={label}
            checked={values.management === type}
            onCheckedChange={(checked) => onChange({ ...values, management: checked ? type : undefined })}
          />
        ))}
      </div>
      <div className="flex flex-col gap-3">
        <GroupLabel>Trust</GroupLabel>
        <Option
          label="Verified listers only"
          checked={values.verifiedOnly === true}
          onCheckedChange={(checked) => onChange({ ...values, verifiedOnly: checked || undefined })}
        />
      </div>
    </div>
  );
}
