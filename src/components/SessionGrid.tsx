import { Session } from '../types/session';
import { SessionCard } from './SessionCard';

interface SessionGridProps {
  sessions: Session[];
  onSessionClick: (session: Session) => void;
}

export function SessionGrid({ sessions, onSessionClick }: SessionGridProps) {
  return (
    <div className="flex flex-col gap-4">
      {sessions.map((session) => (
        <SessionCard
          key={`${session.id}-${session.pid}`}
          session={session}
          onClick={() => onSessionClick(session)}
        />
      ))}
    </div>
  );
}
