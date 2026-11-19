import React from 'react'
import { CircleHelp, ExternalLink, Heart, Info } from 'lucide-react'
import diskframeIcon from '../assets/diskframe-icon.png'
import { SettingsCard, SettingsFacts } from './SettingsCard'
import './AboutConnect.css'

/**
 * Compact footer-style card: what the app is, where to get help, where to
 * find it online. Only links whose destination is real - the GitHub link is
 * the project's own remote, read at build time, never a guess - so there is
 * nothing here that resolves to a page that does not exist.
 */
export interface AboutConnectProps {
  version: string | null
  /** Short git commit the running build was made from, for telling two installs
   *  with the same version apart. 'unknown' for a build made outside git. */
  buildCommit: string | null
}

const REPO_URL = 'https://github.com/NSBforever/DiskFrame'

export default function AboutConnect({
  version,
  buildCommit
}: AboutConnectProps): React.JSX.Element {
  const commit = buildCommit && buildCommit !== 'unknown' ? buildCommit : null
  return (
    <SettingsCard
      id="about"
      icon={<Info size={16} />}
      title="About & Support"
      className="about-card"
    >
      <div className="about-masthead">
        <img src={diskframeIcon} alt="" className="about-logo" />
        <div className="about-identity">
          <div className="about-name">DiskFrame</div>
          <p className="about-description">
            Find and browse your photos, videos and documents across your drives.
          </p>
        </div>
      </div>

      <SettingsFacts
        facts={[
          { label: 'Version', value: version ?? 'Unknown' },
          { label: 'Commit', value: commit ?? 'Not recorded', mono: !!commit }
        ]}
      />

      <div className="about-links">
        <a
          className="df-button about-link"
          href={`${REPO_URL}/issues`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <CircleHelp size={14} aria-hidden="true" />
          Report an Issue
          <ExternalLink size={11} className="about-link-ext" aria-hidden="true" />
        </a>
        <a
          className="df-button about-link"
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub
          <ExternalLink size={11} className="about-link-ext" aria-hidden="true" />
        </a>
      </div>

      <div className="about-footline">
        Made with <Heart size={11} className="about-heart" aria-hidden="true" /> by NSB.
      </div>
    </SettingsCard>
  )
}
