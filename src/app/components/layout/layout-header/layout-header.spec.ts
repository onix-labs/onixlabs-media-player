import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LayoutHeader } from './layout-header';

describe('LayoutHeader', (): void => {
  let component: LayoutHeader;
  let fixture: ComponentFixture<LayoutHeader>;

  beforeEach(async (): Promise<void> => {
    await TestBed.configureTestingModule({
      imports: [LayoutHeader]
    })
    .compileComponents();

    fixture = TestBed.createComponent(LayoutHeader);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', (): void => {
    expect(component).toBeTruthy();
  });
});
