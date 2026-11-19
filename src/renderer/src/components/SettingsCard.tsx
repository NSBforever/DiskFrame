import React from 'react'

/**
 * The pieces every Settings card is built from, so all of them read as one
 * surface: a glass card with an icon, title, one-line description and an
 * optional status chip; rows of label + hint on the left, control on the
 * right; and the one switch used for every on/off setting. Styles live with
 * the rest of the Settings page in assets/main.css.
 */

export type SettingsTone = 'neutral' | 'ok' | 'warn' | 'danger'

export function SettingsCard({
  id,
  icon,
  title,
  description,
  chip,
  className,
  children
}: {
  id: string
  icon: React.ReactNode
  title: string
  description?: React.ReactNode
  chip?: { label: string; tone: SettingsTone }
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section
      className={`glass-panel settings-card${className ? ` ${className}` : ''}`}
      aria-labelledby={`${id}-heading`}
    >
      <header className="settings-card-head">
        <span className="settings-card-icon" aria-hidden="true">
          {icon}
        </span>
        <div className="settings-card-titles">
          <h3 id={`${id}-heading`} className="settings-heading">
            {title}
          </h3>
          {description && <p className="settings-card-desc">{description}</p>}
        </div>
        {chip && <span className={`settings-chip is-${chip.tone}`}>{chip.label}</span>}
      </header>
      {children}
    </section>
  )
}

/** One setting: label and hint on the left, its control on the right. */
export function SettingRow({
  label,
  htmlFor,
  hint,
  children
}: {
  label: React.ReactNode
  /** The control's id, when it is a form control the label can point at. */
  htmlFor?: string
  hint?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="settings-label">
            {label}
          </label>
        ) : (
          <span className="settings-label">{label}</span>
        )}
        {hint && <div className="settings-hint">{hint}</div>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  )
}

/** The on/off switch: a real checkbox (keyboard, form semantics) announced as a switch. */
export function SettingsSwitch({
  id,
  checked,
  onChange
}: {
  id: string
  checked: boolean
  onChange: (on: boolean) => void
}): React.JSX.Element {
  return (
    <input
      id={id}
      className="settings-switch"
      type="checkbox"
      role="switch"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
}

/** Name/value facts in a row of small tiles (versions, last check, commit). */
export function SettingsFacts({
  facts
}: {
  facts: { label: string; value: React.ReactNode; mono?: boolean }[]
}): React.JSX.Element {
  return (
    <dl className="settings-facts">
      {facts.map((f) => (
        <div key={f.label} className="settings-fact">
          <dt>{f.label}</dt>
          <dd className={f.mono ? 'is-mono' : undefined}>{f.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The range slider, with the track filled up to the thumb (--fill, read by the CSS). */
export function SettingsSlider({
  value,
  min,
  max,
  ...rest
}: Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'min' | 'max' | 'value' | 'className' | 'style'
> & {
  value: number
  min: number
  max: number
}): React.JSX.Element {
  return (
    <input
      {...rest}
      type="range"
      className="settings-slider"
      min={min}
      max={max}
      value={value}
      style={{ '--fill': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties}
    />
  )
}
