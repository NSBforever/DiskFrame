import DriveSelectGrid, { Drive } from './DriveSelectGrid'
import { ALL_DRIVES_KEY as ALL_DRIVES } from '../../../main/libraryQuery'

export interface DriveInfo {
  name: string
  filesystem: string
  total: number
  used: number
  free: number
}

interface DriveSelectionViewProps {
  drives: DriveInfo[]
  onDriveSelect: (driveName: string) => void
}

export function DriveSelectionView({
  drives,
  onDriveSelect,
}: DriveSelectionViewProps) {
  const handleSelectDrive = (drive: Drive) => {
    onDriveSelect(drive.letter)
  }

  return (
    <div
      className="view-transition-enter"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100%',
        width: '100%',
        padding: '20px 0',
        boxSizing: 'border-box'
      }}
    >
      <DriveSelectGrid
        onSelectDrive={handleSelectDrive}
        onSelectAll={() => onDriveSelect(ALL_DRIVES)}
        drives={drives}
      />
    </div>
  )
}

export default DriveSelectionView
