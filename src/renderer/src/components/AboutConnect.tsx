import React from 'react'
import { CircleHelp, ExternalLink, Heart } from 'lucide-react'
import diskframeIcon from '../assets/diskframe-icon.png'
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

export default function AboutConnect({ version, buildCommit }: AboutConnectProps): React.JSX.Element {
  return (
    <section className="glass-panel settings-card about-card" aria-labelledby="about-heading">
      <h3 id="about-heading" className="settings-heading">
        About
      </h3>

      <div className="about-masthead">
        <img src={diskframeIcon} alt="" className="about-logo" />
        <div className="about-identity">
          <div className="about-name">
            DiskFrame
            {version && (
              <span className="about-version">
                v{version}
                {buildCommit && buildCommit !== 'unknown' && ` (${buildCommit})`}
              </span>
            )}
          </div>
          <p className="about-description">
            Find and browse your photos, videos and documents across your drives.
          </p>
        </div>
      </div>

      <div className="about-columns">
        <div className="about-column">
          <h4 className="about-column-heading">Help &amp; Feedback</h4>
          <a
            className="about-link"
            href={`${REPO_URL}/issues`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <CircleHelp size={14} aria-hidden="true" />
            Report an issue
            <ExternalLink size={11} className="about-link-ext" aria-hidden="true" />
          </a>
        </div>

        <div className="about-column">
          <h4 className="about-column-heading">Connect</h4>
          <a className="about-link" href={REPO_URL} target="_blank" rel="noopener noreferrer">
            GitHub
            <ExternalLink size={11} className="about-link-ext" aria-hidden="true" />
          </a>
        </div>
      </div>

      <div className="about-footline">
        Made with <Heart size={11} className="about-heart" aria-hidden="true" /> by NSB.
      </div>
    </section>
  )
}
