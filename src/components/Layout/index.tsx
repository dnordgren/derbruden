import * as React from 'react'
import { Link } from 'gatsby'
import { useTheme } from 'emotion-theming'
import styled from '@emotion/styled'
import { transitions, size, padding } from 'polished'
import media from '@/utils/media'
import { Theme, ThemeProps } from '@theme'
import { ReactComponent as LogoIcon } from '@/icons/american-football-helmet.svg'
import { ReactComponent as FooterIcon } from '@/icons/american-football-ball-motion.svg'

const Header = styled.header(({ theme }: ThemeProps) => ({
  display: 'grid',
  gridTemplateColumns: 'auto 1fr auto',
  gridColumnGap: '2rem',
  gridRowGap: '0.5rem',
  alignItems: 'center',
  padding: '1rem',
  backgroundColor: theme.colors.barstoolBlue,
  boxShadow: theme.shadows.basic,
  zIndex: 1,
  [media.sm]: { gridTemplateColumns: 'auto 1fr', gridColumnGap: '1rem' },
}))

const Nav = styled.nav(() => ({
  [media.sm]: { gridColumn: 2 },
  'a:not(:last-child)': { marginRight: '1rem' },
  fontSize: '1.5rem',
}))

const StyledLink = styled(Link)(({ theme }: ThemeProps) => ({
  ...theme.typography.styles.nav,
  ...transitions(['font-weight'], theme.transitions.long),
  ':hover, &.active': {
    fontWeight: 800,
    ...transitions(['font-weight'], theme.transitions.short),
  },
  fontSize: '1.5rem',
}))

const Main = styled.main(({ theme }: ThemeProps) => ({
  display: 'grid',
  gridAutoFlow: 'row',
  justifyItems: 'center',
  alignContent: 'start',
  gridGap: '1.5rem',
  ...padding('3rem', '1rem'),
  backgroundColor: theme.colors.light,
  [media.sm]: { ...padding('1.5rem', null) },
}))

const Footer = styled.footer(({ theme }: ThemeProps) => ({
  backgroundColor: theme.colors.barstoolBlue,
  ...padding('0.5rem', '1rem'),
  textAlign: 'center',
  boxShadow: theme.shadows.basic,
  fontSize: 0,
}))

interface LayoutProps {
  children: React.ReactNode
}

const Layout = ({ children }: LayoutProps) => {
  const theme = useTheme<Theme>()

  return (
    <div css={{ display: 'grid', gridTemplateRows: 'auto 1fr auto', minHeight: '100vh' }}>
      <Header>
        <LogoIcon
          css={{
            ...size('6.5rem'),
            [media.sm]: { ...size('4rem') },
            color: theme.colors.barstoolRed,
          }}
        />
        <StyledLink to="/" css={theme.typography.styles.title} style={{ color: theme.colors.light }}>
          Der Bruden
        </StyledLink>
        <Nav>
          {/* <StyledLink to="/chat/" activeClassName="active" style={{ color: theme.colors.light }}>
            Chat
          </StyledLink> */}
          <StyledLink to="/owners-updates/" activeClassName="active" style={{ color: theme.colors.light }}>
            Owners Updates
          </StyledLink>
          <StyledLink
            to="https://fantasy.espn.com/football/league?leagueId=794521"
            activeClassName="active"
            style={{ color: theme.colors.light }}
          >
            ESPN League
          </StyledLink>
        </Nav>
      </Header>
      <Main>{children}</Main>
      <Footer>
        <a
          href="https://github.com/dnordgren/derbruden"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: theme.colors.light }}
        >
          <FooterIcon width={48} height={'100%'} title="Project page on GitHub" />
        </a>
      </Footer>
    </div>
  )
}

export default Layout
