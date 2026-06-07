"use client";

interface PowerUser {
  name: string;
  initials: string;
  team: string;
  queries: number;
  acceptRate: number;
  lastActive: string;
}

interface PowerUsersTableProps {
  users: PowerUser[];
}

export function PowerUsersTable({ users }: PowerUsersTableProps) {
  if (!users || users.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
        No data available
      </div>
    );
  }

  const maxQueries = Math.max(...users.map((u) => u.queries));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-2 px-2 font-medium text-muted-foreground">
              Advisor
            </th>
            <th className="text-right py-2 px-2 font-medium text-muted-foreground">
              Queries
            </th>
            <th className="text-right py-2 px-2 font-medium text-muted-foreground">
              Accept rate
            </th>
            <th className="text-left py-2 px-2 font-medium text-muted-foreground">
              Last active
            </th>
          </tr>
        </thead>
        <tbody>
          {users.map((user, i) => (
            <tr key={i} className="border-b border-border/50">
              <td className="py-2 px-2">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-gold flex items-center justify-center text-[10px] font-semibold text-white">
                    {user.initials}
                  </div>
                  <div>
                    <div className="font-medium">{user.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {user.team} team
                    </div>
                  </div>
                </div>
              </td>
              <td className="py-2 px-2 text-right">
                <div className="tabular-nums">{user.queries}</div>
                <div className="h-1.5 w-20 bg-muted/30 rounded-full mt-1 ml-auto">
                  <div
                    className="h-full bg-gold rounded-full"
                    style={{ width: `${(user.queries / maxQueries) * 100}%` }}
                  />
                </div>
              </td>
              <td className="py-2 px-2 text-right">
                <span className="inline-block px-2 py-0.5 rounded text-[11px] font-medium bg-chart-teal/20 text-chart-teal">
                  {user.acceptRate}%
                </span>
              </td>
              <td className="py-2 px-2 text-muted-foreground">{user.lastActive}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
