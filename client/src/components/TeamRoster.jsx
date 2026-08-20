import { useMyTeam } from "../MyTeamContext";
import RosterTable from "./RosterTable";

export default function TeamRoster() {
  const { myTeamId } = useMyTeam();
  return <RosterTable teamId={myTeamId} />;
}
